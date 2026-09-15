import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A DATE column holds the day on the family's kitchen wall. `toISOString()
// .slice(0, 10)` answers the day at Greenwich. Comparing one to the other is
// wrong for a large, predictable slice of every day:
//
//     America/Los_Angeles   420 min/day   (29.2%)
//     America/New_York      240 min/day   (16.7%)
//     Asia/Tokyo            540 min/day   (37.5%)
//     Australia/Sydney      600 min/day   (41.7%)
//
// Measured end to end before the fix: at 18:30 on a Sunday in Los Angeles the
// kitchen page asked `meal_plans` for plan_date = 2026-09-14 and rendered
// "Monday pasta" while the family was eating the Sunday roast. The family
// display was worse — it took the SERVER's midnight, so a wall-mounted screen
// turned over to tomorrow at 5pm.
//
// `lib/services/scope.ts` has carried dayKeyInTz/zonedDayBoundsMs for exactly
// this, and its own header names the bug. This guard is about adoption.
const ROOTS = ['app', 'lib'];
const CODE = new Set(['.ts', '.tsx']);

/**
 * Files that still derive a Greenwich day key next to a DATE filter, each with
 * the reason it has not been converted. Shrinking this list is the point of it;
 * adding to it needs a reason as good as these.
 */
const ALLOWED = new Map([
  // Platform-wide aggregation across every family at once. There is no single
  // family zone to resolve, and UTC bucketing is what a cross-household
  // benchmark should use.
  ['lib/network/aggregate-server.ts', 'platform-wide aggregation; UTC bucketing is correct'],
  // Cron, all families in one pass. Cost of not resolving each family's zone is
  // bounded at one day early for families west of UTC; documented in the file.
  ['app/api/cron/wallet-allowance/route.ts', 'platform-wide cron; bounded to one day early, documented in file'],
  // Background derivation rather than something a family reads as "today".
  // Each takes familyId but not a zone, so converting means threading one
  // through; worth doing, not yet done.
  ['lib/autopilot/scan.ts', 'background scan; needs a tz threaded through its signature'],
  ['lib/finance/timeline-load.ts', 'derived timeline; needs a tz threaded through its signature'],
  ['lib/operating-index/server.ts', 'snapshot key; needs a tz threaded through its signature'],
  ['lib/planning/prep-server.ts', 'prep generation; needs a tz threaded through its signature'],
  ['app/(app)/dashboard/family-digital-twin/actions.ts', 'simulation input over a month window; a day either way does not move the result'],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (CODE.has(extname(path))) out.push(path);
  }
  return out;
}

/** DATE columns, read out of the migrations so this needs no database. */
function dateColumns(): Set<string> {
  const cols = new Set<string>();
  const dir = 'supabase/migrations';
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    // `  foo date not null default ...` — a bare `date`, never timestamptz.
    for (const m of sql.matchAll(/^\s*"?([a-z_]+)"?\s+date\b(?!\s*time)/gim)) cols.add(m[1]);
  }
  return cols;
}

const UTC_DAY_KEY = /toISOString\(\)\s*\.slice\(0,\s*10\)/;

/**
 * What this can and cannot claim.
 *
 * A regex cannot follow a value from where it is built to where it is used, so
 * it cannot prove that THIS Greenwich key reaches THAT date filter. What it can
 * say is that a file builds one, filters a DATE column, and never reaches for
 * the zone helpers at all — which is the signature of a surface nobody has
 * considered, and is how all nineteen of these were found.
 *
 * A file that imports the helpers has been thought about, so it is not flagged:
 * a Greenwich key there is usually a cache key, a log line, or an instant. That
 * is a deliberate blind spot, and the reason this guard is a floor rather than
 * a proof.
 */
const ZONE_AWARE = /dayKeyInTz|zonedDayBoundsMs|zonedTimeMs|dayKeysBetween|hourInTz/;

function greenwichDayNextToDateFilter(source: string, cols: Set<string>): string[] {
  if (!UTC_DAY_KEY.test(source)) return [];
  if (ZONE_AWARE.test(source)) return [];
  const filtered = new Set<string>();
  for (const m of source.matchAll(/\.(?:gte|lte|gt|lt|eq|neq)\(\s*'([a-z_]+)'/g)) {
    if (cols.has(m[1])) filtered.add(m[1]);
  }
  return [...filtered].sort();
}

describe("a family's day is not Greenwich's day", () => {
  const cols = dateColumns();

  it('reads DATE columns with a day key resolved in the family zone', () => {
    expect(cols.size, 'DATE columns should be discoverable from the migrations').toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const hit = greenwichDayNextToDateFilter(readFileSync(file, 'utf8'), cols);
        if (hit.length === 0) continue;
        if (ALLOWED.has(file)) continue;
        offenders.push(`${file} — filters ${hit.join(', ')} with a Greenwich day key; use dayKeyInTz(now, tz)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still needs to be there', () => {
    // An allowlist that outlives its reason is how a guard rots. If a file was
    // fixed, its entry must go, or the next one to regress hides behind it.
    const stale: string[] = [];
    for (const [file] of ALLOWED) {
      const hit = greenwichDayNextToDateFilter(readFileSync(file, 'utf8'), cols);
      if (hit.length === 0) stale.push(`${file} no longer needs its exemption — remove it`);
    }
    expect(stale).toEqual([]);
  });

  it('recognises the pattern it forbids', () => {
    const cols2 = new Set(['plan_date']);
    const bad = "const today = now.toISOString().slice(0, 10);\n.eq('plan_date', today)";
    expect(greenwichDayNextToDateFilter(bad, cols2)).toEqual(['plan_date']);
    // A file that reaches for the zone helpers is not flagged, and neither is a
    // UTC key with no DATE filter beside it.
    expect(greenwichDayNextToDateFilter("dayKeyInTz(now, tz);\ntoISOString().slice(0, 10);\n.eq('plan_date', k)", cols2)).toEqual([]);
    expect(greenwichDayNextToDateFilter("now.toISOString().slice(0, 10);\n.eq('starts_at', k)", cols2)).toEqual([]);
  });
});
