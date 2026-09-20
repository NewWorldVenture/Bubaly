import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `.limit(n)` for n above the server's row ceiling is not a bound — it is a
// silent truncation wearing the costume of a deliberate choice.
//
// PostgREST caps a response at `db-max-rows` (1,000 on a default Supabase
// project) whatever the client asked for. Measured against the live local
// project:
//
//     habit_logs      table=6500   asked .limit(5000) → got 1000
//     graph_entities  table=3709   asked .limit(4000) → got 1000
//
// Twenty-six call sites had written such a limit. Each one read as a considered
// ceiling in review, and each one quietly returned 1,000 rows: habit streaks
// computed from a sixth of the history, a family knowledge graph a quarter of
// its real size, wallet balances totalled from part of the ledger. Nothing
// logged, because from the query's point of view the table simply ended.
//
// Pass the number you mean to `readAll`/`readAllAsQuery` as `max` and it is
// honoured by paging to it. A `.limit()` at or below the cap is a real bound and
// is left alone.
const ROW_CAP = 1000;
// `components` belongs here too: a client component reaches PostgREST through
// the same browser client and is capped by the same `db-max-rows`. It was left
// out, and two over-cap limits survived there — a vocab deck and the calendar
// busyness strip, the latter ordered ASCENDING so truncation dropped the most
// recent weeks, which is the half the strip exists to show.
const ROOTS = ['app', 'lib', 'components'];
const CODE = new Set(['.ts', '.tsx']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (CODE.has(extname(path))) out.push(path);
  }
  return out;
}

/** `.limit(n)` occurrences in real code — comments explaining the rule don't count. */
function overCapLimits(source: string): { line: number; text: string; n: number }[] {
  const found: { line: number; text: string; n: number }[] = [];
  source.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
    for (const match of raw.matchAll(/\.limit\((\d+)\)/g)) {
      const n = Number(match[1]);
      if (n > ROW_CAP) found.push({ line: index + 1, text: line, n });
    }
  });
  return found;
}

describe('no read asks for more rows than the server will return', () => {
  it('has no .limit() above the row cap anywhere in app/, lib/ or components/', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        for (const hit of overCapLimits(readFileSync(file, 'utf8'))) {
          offenders.push(`${file}:${hit.line} .limit(${hit.n}) — use readAll(…, { max: ${hit.n} })`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises an over-cap limit when it sees one', () => {
    // Non-vacuity: the scan must actually catch the pattern it forbids, and must
    // not fire on a bound that is real or on prose describing the rule.
    expect(overCapLimits("  .eq('family_id', id).limit(5000),")).toHaveLength(1);
    expect(overCapLimits("  .limit(1000),")).toHaveLength(0);
    expect(overCapLimits("  .limit(200),")).toHaveLength(0);
    expect(overCapLimits("  // `.limit(5000)` is not a bound")).toHaveLength(0);
    expect(overCapLimits(" * `.limit(5000)` against a default project")).toHaveLength(0);
  });
});
