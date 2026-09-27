import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `readAll` exists because PostgREST answers an unbounded select with at most
// db-max-rows and says nothing about it. F-008/F-011/F-013 fixed the default
// ceiling; F-F01 fixed the caller-supplied one, so the helper now reads ONE row
// past `max` and returns an error when more remain:
//
//   readAll reached the caller's max of 2000 rows and more remain.
//   These rows are a PREFIX, not the whole set — treat this as a failed read.
//
// That signal is worth exactly as much as the call sites that read it, and
// eight of them did not. Each carried a comment explaining why a capped read
// would be wrong — "a capped read understates spending", "a capped read does
// not shorten a list, it reports the wrong number", "would have started
// re-opening issues it believed unlinked" — and then destructured `{ rows }`,
// dropping the error that says it just happened.
//
// So: every result from this helper has to have its error consumed. Not
// necessarily surfaced to a person — `safe()` on the marketplace page logs it
// and records a data warning, which is a decision — but never discarded
// silently.
const HELPER = '@/lib/supabase/read-all';
const CALL = /\breadAll(AsQuery)?\s*[<(]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

/** Comment bodies blanked, newlines kept, so prose about `error` is not a check. */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Call sites in one file that destructure the helper's result and leave the
 * error out.
 *
 * Only this shape is reported. A call passed into `settle`, `settleAll`,
 * `safe` or a chunked reader belongs to that wrapper's result, which is itself
 * destructured somewhere — and the array form of that is checked separately
 * below. Reporting what the walk cannot resolve would make this the kind of
 * guard that is disabled the first time it cries wolf.
 */
export function droppedErrors(source: string): string[] {
  const lines = blankComments(source).split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!CALL.test(line) || /^\s*import\b/.test(line)) return;
    let start = i;
    for (let k = i; k >= Math.max(0, i - 4); k--) {
      if (/\b(const|let|var)\b/.test(lines[k])) { start = k; break; }
    }
    const stmt = lines.slice(start, i + 1).join(' ');
    const object = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+readAll/.exec(stmt);
    if (object && !/\berror\b/.test(object[1])) out.push(`line ${i + 1}: { ${object[1].trim()} }`);
  });
  return out;
}

/** Split at commas that are not inside (), [], {}, <>, a string or a template. */
function topLevelSplit(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

/**
 * Batch form: `const [a, { data: b }] = await settleAll([ … ])`.
 *
 * Positional, so it reports the binding that belongs to the readAll element and
 * not its neighbours. A binding is satisfied either by destructuring `error`
 * itself or — when it names the whole result — by `<name>.error` appearing in
 * the code that follows, which is how the wallet reconciliation and economy
 * pages check theirs.
 */
export function droppedInBatch(source: string): string[] {
  const src = blankComments(source);
  const out: string[] = [];
  const open = /\b(?:const|let|var)\s*\[/g;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const lb = src.indexOf('[', m.index);
    // Binding list: to the matching close bracket.
    let depth = 0, rb = -1;
    for (let i = lb; i < src.length; i++) {
      if (src[i] === '[') depth++;
      else if (src[i] === ']') { depth--; if (depth === 0) { rb = i; break; } }
    }
    if (rb < 0) continue;
    const assign = /^\s*(?::[^=]*)?=\s*await\s+(?:settleAll|Promise\.all)\s*\(\s*\[/.exec(src.slice(rb + 1));
    if (!assign) continue;
    const arrayStart = rb + 1 + assign[0].lastIndexOf('[');
    let d2 = 0, arrayEnd = -1;
    for (let i = arrayStart; i < src.length; i++) {
      if (src[i] === '[') d2++;
      else if (src[i] === ']') { d2--; if (d2 === 0) { arrayEnd = i; break; } }
    }
    if (arrayEnd < 0) continue;

    const bindings = topLevelSplit(src.slice(lb + 1, rb)).map((b) => b.trim());
    const elements = topLevelSplit(src.slice(arrayStart + 1, arrayEnd));
    const after = src.slice(arrayEnd, arrayEnd + 4000);
    const line = src.slice(0, lb).split('\n').length;

    elements.forEach((element, i) => {
      if (!CALL.test(element)) return;
      // A call nested inside a wrapper is the wrapper's result, not the
      // helper's: `safe('Saved listings', readAllAsQuery(…))` consumes the
      // error itself and answers a plain array, so the binding has no `.error`
      // to read and asking for one would report a handled case as a defect.
      if (/\b(safe|settle|settleAll|readInChunks)\s*[<(]/.test(element.slice(0, element.search(CALL)))) return;
      const binding = bindings[i];
      if (!binding) return;
      if (binding.startsWith('{')) {
        if (!/\berror\b/.test(binding)) out.push(`line ${line}: element ${i + 1} bound as ${binding.replace(/\s+/g, ' ').slice(0, 40)}`);
        return;
      }
      const name = /^([A-Za-z_$][\w$]*)/.exec(binding)?.[1];
      if (!name) return;
      // Satisfied by any statement that mentions the binding AND an error. A
      // literal `r.error` is the common form, but several pages collect the
      // results and ask once —
      //   [reminders, events, choreRows].find((result) => result.error)
      // — where the binding and the `.error` are in the same statement and
      // never adjacent. Requiring `name.error` reports those as defects, which
      // is how a guard teaches people to delete it.
      // Deliberately forgiving for a NAMED binding: it counts as checked when
      // the name is used again and the surrounding code checks errors at all.
      //
      // The strict rule was tried and it reports working code. These pages
      // collect their results and ask once, across statements and across
      // lines —
      //
      //   const readFailures = ([['families', familiesResult], …]).filter(([, r]) => r.error)
      //   const readResults = [renewalsResult, …, choreHistoryResult, …];
      //   if (readResults.some((result) => result.error)) throw …
      //
      // — so demanding `name.error` flags five handled reads on the admin
      // reports page and one in the Autopilot scan. A guard that reports
      // correct code is a guard somebody deletes, and the shape that actually
      // went wrong eight times is the DESTRUCTURE above, which is checked
      // exactly. This catches the weaker case: a result nobody looks at again.
      const mentioned = new RegExp(`\\b${name}\\b`).test(after);
      const checksErrors = /\berror\b/.test(after);
      if (!mentioned || !checksErrors) {
        out.push(`line ${line}: element ${i + 1} bound as ${name}, whose error is never read`);
      }
      return;
    });
  }
  return out;
}

describe('a capped read is not a silent one', () => {
  const files = [...walk('app'), ...walk('lib'), ...walk('components')]
    .filter((f) => f !== join('lib', 'supabase', 'read-all.ts'))
    .filter((f) => readFileSync(f, 'utf8').includes(HELPER));

  it('finds the call surface (sanity: the walk works)', () => {
    // Scoped to files that IMPORT the helper. `lib/metric/strategy-server.ts`
    // defines its own local `readAll` — a keyset pager over `id` — and a
    // name-only scan reports nine false positives there.
    expect(files.length).toBeGreaterThan(30);
    const calls = files.reduce(
      (n, f) => n + blankComments(readFileSync(f, 'utf8')).split('\n').filter((l) => CALL.test(l) && !/^\s*import\b/.test(l)).length, 0);
    expect(calls).toBeGreaterThan(50);
  });

  it('reads the two shapes it claims to (sanity: the matcher works)', () => {
    expect(droppedErrors('const { rows } = await readAll((f, t) => q.range(f, t), { max: 10 });'))
      .toEqual(['line 1: { rows }']);
    expect(droppedErrors('const { rows: tx } = await readAll((f, t) => q.range(f, t));'))
      .toEqual(['line 1: { rows: tx }']);
    expect(droppedErrors('const { rows, error } = await readAll((f, t) => q.range(f, t));')).toEqual([]);
    expect(droppedErrors('const { rows, error: readError } = await readAll((f, t) => q.range(f, t));')).toEqual([]);
    // Prose is not a check.
    expect(droppedErrors('// the error is handled below\nconst { rows } = await readAll((f, t) => q.range(f, t));'))
      .toEqual(['line 2: { rows }']);
    // A call handed to a wrapper is that wrapper's result to destructure.
    expect(droppedErrors("const x = safe('L', readAllAsQuery((f, t) => q.range(f, t)));")).toEqual([]);

    expect(droppedInBatch('const [{ data: a }] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n]);').length).toBe(1);
    expect(droppedInBatch('const [{ data: a, error: e }] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n]);')).toEqual([]);
    // A named result satisfies it by having its .error read afterwards.
    expect(droppedInBatch('const [r] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n]);\nif (r.error) fail();')).toEqual([]);
    // Collected and asked once, which is what several pages do.
    expect(droppedInBatch('const [a, b] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n  q2,\n]);\nconst e = [a, b].find((r) => r.error);')).toEqual([]);
    expect(droppedInBatch('const [r] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n]);\nconst x = r.data;').length).toBe(1);
    // Used again, in a region that checks errors somewhere: accepted.
    expect(droppedInBatch('const [a, b] = await settleAll([\n  readAllAsQuery((f, t) => q.range(f, t)),\n  q2,\n]);\nconst all = [a, b];\nif (all.some((r) => r.error)) fail();')).toEqual([]);
    // POSITIONAL: the readAll is the second element, so the first binding's
    // missing error is not this helper's business.
    expect(droppedInBatch('const [{ data: a }, { rows: b, error: e }] = await Promise.all([\n  q1,\n  readAll((f, t) => q.range(f, t)),\n]);')).toEqual([]);
    expect(droppedInBatch('const [{ data: a }, { rows: b }] = await Promise.all([\n  q1,\n  readAll((f, t) => q.range(f, t)),\n]);').length).toBe(1);
    // A batch with no readAll in it is none of this test's business.
    expect(droppedInBatch('const [{ data: a }] = await settleAll([\n  sb.from("t").select("id"),\n]);')).toEqual([]);
  });

  it('has no call site that destructures the rows and drops the error', () => {
    const offenders = files.flatMap((f) => droppedErrors(readFileSync(f, 'utf8')).map((d) => `${f} :: ${d}`));
    expect(offenders, `readAll results whose truncation error is discarded:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('has no batch destructure that drops it either', () => {
    const offenders = files.flatMap((f) => droppedInBatch(readFileSync(f, 'utf8')).map((d) => `${f} :: ${d}`));
    expect(offenders, `readAll results inside a batch whose error is never bound:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the helper still produces the signal these call sites depend on', () => {
    // A guard over call sites is worth nothing if the thing they consume stops
    // being produced. This is the one assertion about the helper itself.
    const src = readFileSync('lib/supabase/read-all.ts', 'utf8');
    expect(src).toContain('const probe = ceiling + 1');
    expect(src).toMatch(/options\.max !== undefined/);
    expect(src).toContain('PREFIX, not the whole set');
  });
});
