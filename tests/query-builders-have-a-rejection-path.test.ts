import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A Supabase query builder RESOLVES with `{ data, error }` for anything the
// database answers — RLS denials, missing tables, constraint violations — and
// REJECTS only when the request never completed: DNS, TCP, TLS, an aborted
// fetch. `lib/supabase/settle.ts` exists because of that second path.
//
// `.then(handler)` supplies only the first. So a builder consumed by a bare
// `.then()` handles every database failure and none of the network ones, which
// is the failure mode a degrade path most needs to survive. Four such sites
// existed and each broke differently:
//
//   busyness-heatmap    rejection → unhandled; the strip also dropped `error`
//                       and rendered eight calm weeks over a broken read
//   app-lock-settings   rejection → stuck on the loading dash forever
//   meals-module        rejection → the meal library silently never updated
//   calm/page.tsx       rejection → straight through `Promise.all` and out of
//                       the page, rendering the error boundary INSTEAD of the
//                       degraded view the page was carefully built to show
//
// Measured for the last one: three reads with one rejecting, `Promise.all`
// throws without a rejection path and resolves with 3/3 failures counted with
// it. Every sibling hub page's local `safe` already used try/catch — that one
// was the outlier.
//
// The rule: if a query builder is consumed by `.then()`, there must be a
// rejection path — a `.catch()`, a second `.then` argument, or `settle()`.
const ROOTS = ['app', 'lib', 'components'];
const CODE = new Set(['.ts', '.tsx']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (CODE.has(extname(p))) out.push(p);
  }
  return out;
}

/**
 * `.then(` calls whose result shape is a PostgREST answer — the destructured
 * first parameter mentions `data`, `error` or `count` — with no rejection path.
 *
 * The arguments are split by tracking bracket depth from the `.then(` paren
 * rather than by regex. A first attempt matched `}` `,` to spot the
 * two-argument `.then(onFulfilled, onRejected)` form and reported the file that
 * had just been FIXED to use it: the handler body `({ data })` puts a `)`
 * between the `}` and the `,`. A guard whose false positive is the correct code
 * is worse than no guard.
 *
 * Scoped to the result shape deliberately. A `.then()` on an ordinary promise is
 * not this rule's business, and `settle`/`settleAll` never reject.
 */
export function bareThenOnAResultShape(source: string): number[] {
  const hits: number[] = [];
  const OPEN = '([{';
  const CLOSE = ')]}';
  for (const m of source.matchAll(/\.then\(/g)) {
    const open = m.index + m[0].length - 1;   // the '(' of `.then(`
    // Walk to the matching ')' , recording commas at argument depth.
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < source.length; i++) {
      const c = source[i];
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) {
        depth--;
        if (depth === 0) { close = i; break; }
      } else if (c === ',' && depth === 1) commas.push(i);
    }
    if (close === -1) continue;

    const args = source.slice(open + 1, close);
    const first = commas.length ? source.slice(open + 1, commas[0]) : args;
    const destructured = /^\s*(?:function\s*)?\(?\s*\{([^}]*)\}/.exec(first);
    if (!destructured) continue;
    if (!/\b(data|error|count)\b/.test(destructured[1])) continue;

    // Two arguments to `.then` IS the rejection path.
    if (commas.length > 0) continue;
    // `.catch(` chained onto this call.
    if (/^\s*\.catch\s*\(/.test(source.slice(close + 1))) continue;
    // Consuming a `settle(...)`/`settleAll(...)`, which never reject.
    if (/\bsettle(All)?\s*\(/.test(source.slice(Math.max(0, open - 300), open))) continue;

    hits.push(source.slice(0, m.index).split('\n').length);
  }
  return hits;
}

describe('a query builder consumed by .then() has a rejection path', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it('scans a meaningful number of source files', () => {
    // A walk that quietly found nothing would pass the case below.
    expect(files.length).toBeGreaterThan(800);
  });

  it('has no bare .then() on a PostgREST result shape', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of bareThenOnAResultShape(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${line} — .then() on a query result with no rejection path; use settle() or add .catch()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises the pattern it forbids, and the three ways of satisfying it', () => {
    const bare = "supabase.from('x').select('*').then(({ data }) => setRows(data ?? []));";
    expect(bareThenOnAResultShape(bare)).toEqual([1]);

    // A rejection path, in each of its legitimate forms.
    expect(bareThenOnAResultShape(
      "supabase.from('x').select('*').then(({ data }) => setRows(data)).catch(() => {});")).toEqual([]);
    expect(bareThenOnAResultShape(
      "Promise.resolve(p).then(({ data }) => ({ data }), (cause) => ({ data: [], cause }));")).toEqual([]);
    expect(bareThenOnAResultShape(
      "settle(supabase.from('x').select('*')).then(({ data, error }) => done(data, error));")).toEqual([]);

    // Not this rule's business: a `.then` on something that is not a result shape.
    expect(bareThenOnAResultShape("fetchThing().then(({ name }) => setName(name));")).toEqual([]);
  });
});
