import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `readAllAsQuery` reports a failed OR TRUNCATED read as `data: null` plus an
// error — deliberately, so it can sit inside a `settleAll([...])` batch and let
// each caller's own error branch key on it (lib/supabase/read-all.ts:139-141).
//
// A call site that destructures only `{ data }` therefore turns a truncated
// read into an EMPTY ARRAY. On a money read that is not a short list, it is a
// balance of zero. Audit C4-S4-02 found exactly that on two routes that feed
// the figure to an LLM, which then wrote coaching prose about a child's money
// that was computed from nothing — under a comment that said, verbatim, "Money,
// so a quietly truncated read is a wrong balance, not a short list."
//
// `tests/no-limit-above-the-row-cap.test.ts` already enforces the read's SHAPE.
// Nothing enforced that its ERROR is consumed, which is why thirteen call sites
// drifted. This is that guard.

const ROOTS = ['app', 'lib', 'components'];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (['.ts', '.tsx'].includes(extname(entry.name))) out.push(path);
  }
  return out;
}

/**
 * Sites binding `readAllAsQuery`'s output that never consume its error.
 *
 * The repository consumes it in THREE shapes, and a matcher that knows only one
 * reports the other two as defects. Building this cost three passes and two
 * false-positive sets — recorded here so the next reader does not repeat it:
 *
 *   1. inline        `const [{ data, error }] = await settleAll([...])`
 *   2. result object `const [aRes, bRes] = ...; const e = aRes.error ?? bRes.error`
 *   3. array search  `const e = [aRes, bRes].find((r) => r.error)?.error`
 *   4. labelled table `([['families', aRes], …]).filter(([, res]) => res.error)`
 *
 * So the rule is: a bound name that appears on any nearby line mentioning
 * `error` is consuming it. Deliberately permissive — a guard that cries wolf
 * gets weakened until it means nothing, which is the failure mode this
 * repository is most prone to.
 *
 * Shape 4 arrived from the other audit session and this matcher called all five
 * of its reads defects. It is the idiom where the RESULT and the word `error`
 * are never on one line: the results go into a table of [label, result] pairs
 * and the error is read through an element alias, `([, res]) => res.error`. The
 * fourth false-positive set, and the reason the window below is generous: the
 * sweep sat thirty lines past the call.
 */
function unconsumedSites(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (!/readAllAsQuery/.test(line)) return;
    // The destructure sits at the head of the statement, which may be lines above.
    const head = lines.slice(Math.max(0, i - 14), i + 1).join('\n');
    const destructure = /const\s*\[([\s\S]*?)\]\s*=\s*await\s+settleAll|const\s*\{([\s\S]*?)\}\s*=\s*await\s+readAllAsQuery/.exec(head);
    if (!destructure) return;
    const bound = destructure[1] ?? destructure[2] ?? '';
    if (/\berror\b/.test(bound)) return;                       // shape 1
    const names = bound.match(/[A-Za-z_$][\w$]*/g) ?? [];
    const after = lines.slice(i, i + 40);
    const consumed = names.some((n) =>
      after.some((l) => l.toLowerCase().includes('error') && new RegExp(`\\b${n}\\b`).test(l)))
      // Shape 4: the name is carried into a structure whose elements are swept
      // for `.error`. Both halves are required — a name that is merely used, in
      // a region where no error is examined at all, is still the defect.
      || (names.some((n) => after.some((l) => new RegExp(`\\b${n}\\b`).test(l)))
          && after.some((l) => /\.\s*error\b/.test(l)));
    if (!consumed) hits.push(`${i + 1}: ${line.trim().slice(0, 90)}`);  // shapes 2 & 3
  });
  return hits;
}

describe('a truncated read is never silently an empty array (C4-S4-02)', () => {
  const files = ROOTS.flatMap((r) => walk(resolve(r), []));

  it('the matcher finds readAllAsQuery call sites at all', () => {
    // A matcher that silently matched nothing would make this rule vacuous —
    // the defect class this repository is most prone to.
    const withCalls = files.filter((f) => readFileSync(f, 'utf8').includes('readAllAsQuery'));
    expect(withCalls.length).toBeGreaterThan(0);
  });

  it('NO file in the tree binds readAllAsQuery and drops its error', () => {
    // The class, not the instances. C4-S4-01 found 13 of 59 call sites never
    // migrated after the helper's contract changed: they used to render a
    // PREFIX and now render ZERO, because a truncated read arrives as
    // `data: null`. Enumerating the offenders would let the next one in.
    const offenders = files.flatMap((f) => {
      const rel = f.slice(f.indexOf('/Bubaly/') + 8);
      return unconsumedSites(readFileSync(f, 'utf8')).map((h) => `${rel}:${h}`);
    });
    expect(offenders, 'these bind readAllAsQuery and never read its error').toEqual([]);
  });

  it('the two AI money routes consume the read error', () => {
    // These are the sites C4-S4-02 named: a child's balance, fed to a model.
    for (const f of [
      'app/api/ai/wallet/route.ts',
      'app/api/ai/wallet/child/[childId]/route.ts',
    ]) {
      const source = readFileSync(resolve(f), 'utf8');
      expect(source, `${f} must bind readAllAsQuery's error`).toMatch(/data:\s*txns,\s*error:\s*txnsError/);
      expect(source, `${f} must branch on it`).toMatch(/if\s*\(txnsError\)/);
      expect(unconsumedSites(source), `${f} has an unconsumed readAllAsQuery`).toEqual([]);
    }
  });
});
