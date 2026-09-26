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

// Directory traversal uses the host separator; the reviewed registry uses
// repository paths. Match the complete path on Windows and POSIX alike.
function allowedFile(registry: Map<string, string>, file: string): boolean {
  return registry.has(file.replaceAll('\\', '/'));
}

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
  ['lib/family/signals.ts', 'background signals; needs a tz threaded through its signature'],
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

// Two spellings of the same thing. The second was invisible to this guard
// until a grade date written with it was found in `components/`.
const UTC_DAY_KEY = /toISOString\(\)\s*(?:\.slice\(0,\s*10\)|\.split\('T'\)\[0\])/;

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
        if (allowedFile(ALLOWED, file)) continue;
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

  it('normalizes separators without exempting an unlisted sibling', () => {
    expect(allowedFile(ALLOWED, 'lib/network/aggregate-server.ts')).toBe(true);
    expect(allowedFile(ALLOWED, 'lib\\network\\aggregate-server.ts')).toBe(true);
    expect(allowedFile(ALLOWED, 'lib/network/another-aggregate-server.ts')).toBe(false);
    expect(allowedFile(ALLOWED, 'lib\\network\\another-aggregate-server.ts')).toBe(false);
    const unsafe = "const today = now.toISOString().slice(0, 10); .eq('plan_date', today)";
    expect(greenwichDayNextToDateFilter(unsafe, new Set(['plan_date']))).toEqual(['plan_date']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The write side.
//
// The check above watches DATE columns being READ. A Greenwich day WRITTEN into
// a DATE column is the worse half: a wrong read renders one wrong screen, a
// wrong write persists and every later read of that row is wrong too.
//
// It is also checkable far more precisely. Rather than "this file builds a
// Greenwich key somewhere and filters a DATE column somewhere", this asks the
// exact question: is the value assigned to a DATE column a Greenwich day key?
// That needs no ZONE_AWARE escape hatch and no whole-file blind spot — a file
// that writes `spent_on: todayInZone(tz)` simply does not match.
//
// `components` is in scope here and not above, because the write sites are
// overwhelmingly form defaults: the day a parent gets when they leave the date
// blank. At 18:30 in Los Angeles that default was tomorrow.
const WRITE_ROOTS = ['app', 'lib', 'components'];

/**
 * Still writing a Greenwich day into a DATE column, each with the reason.
 * Same rule as the read allowlist: shrinking it is the point.
 */
const WRITE_ALLOWED = new Map([
  // Server actions that take a family but no zone. Converting means threading a
  // zone through the action's `ctx()`, which is worth doing and not yet done.
  ['app/(app)/dashboard/auto/actions.ts', 'server action; needs a zone threaded through ctx()'],
  ['app/(app)/dashboard/home/actions.ts', 'server action; needs a zone threaded through ctx()'],
  ['app/(app)/wallet/hub-actions.ts', 'server action; needs a zone threaded through ctx()'],
  ['lib/planning/prep-server.ts', 'prep generation; needs a tz threaded through its signature'],
  // `reasoning_snapshots` is keyed (family_id, as_of_date) and upserted once a
  // day. Changing the key changes what "already snapshotted today" means, so it
  // wants its own change with the idempotency thought through, not a drive-by.
  ['lib/reasoning/engine-server.ts', 'as_of_date is an upsert key; changing it changes daily idempotency'],
]);

/**
 * The value expression assigned to `key:`, starting just past the colon.
 * Depth-aware, so a comma inside a call — `str(fd, 'service_date') ?? …` — does
 * not end the value early. A plain `[^,]*` missed exactly that case.
 */
function propertyValue(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length && i < from + 400; i++) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return source.slice(from, i);
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return source.slice(from, i);
  }
  return source.slice(from, from + 400);
}

function greenwichDayWrittenToDateColumn(source: string, cols: Set<string>): string[] {
  const written = new Set<string>();
  for (const m of source.matchAll(/\b([a-z_]+)\s*:/g)) {
    if (!cols.has(m[1])) continue;
    if (UTC_DAY_KEY.test(propertyValue(source, m.index + m[0].length))) written.add(m[1]);
  }
  return [...written].sort();
}

describe('a DATE column is never written a Greenwich day', () => {
  const cols = dateColumns();

  it('writes DATE columns with a day key resolved in the family zone', () => {
    const offenders: string[] = [];
    for (const root of WRITE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const hit = greenwichDayWrittenToDateColumn(readFileSync(file, 'utf8'), cols);
        if (hit.length === 0) continue;
        if (allowedFile(WRITE_ALLOWED, file)) continue;
        offenders.push(`${file} — writes ${hit.join(', ')} as a Greenwich day key; use todayInZone(tz)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the write allowlist honest — every entry still needs to be there', () => {
    const stale: string[] = [];
    for (const [file] of WRITE_ALLOWED) {
      const hit = greenwichDayWrittenToDateColumn(readFileSync(file, 'utf8'), cols);
      if (hit.length === 0) stale.push(`${file} no longer needs its exemption — remove it`);
    }
    expect(stale).toEqual([]);
  });

  it('recognises the pattern it forbids, in both spellings and past a nested comma', () => {
    const cols2 = new Set(['spent_on', 'service_date']);
    expect(greenwichDayWrittenToDateColumn("{ spent_on: new Date().toISOString().slice(0, 10) }", cols2)).toEqual(['spent_on']);
    // The `.split('T')[0]` spelling — the one that hid a real write in school-module.
    expect(greenwichDayWrittenToDateColumn("{ spent_on: new Date().toISOString().split('T')[0] }", cols2)).toEqual(['spent_on']);
    // A comma inside a call must not end the value early.
    expect(greenwichDayWrittenToDateColumn("{ service_date: str(fd, 'service_date') ?? new Date().toISOString().slice(0, 10) }", cols2)).toEqual(['service_date']);
    // A zone-resolved write is not flagged, and neither is a Greenwich key
    // assigned to something that is not a DATE column.
    expect(greenwichDayWrittenToDateColumn("{ spent_on: todayInZone(tz) }", cols2)).toEqual([]);
    expect(greenwichDayWrittenToDateColumn("{ label: new Date().toISOString().slice(0, 10) }", cols2)).toEqual([]);
    // The value of the NEXT property must not leak into this one.
    expect(greenwichDayWrittenToDateColumn("{ spent_on: row.day, note: new Date().toISOString().slice(0, 10) }", cols2)).toEqual([]);
  });

  it('uses the same exact repository identity for write exemptions on both hosts', () => {
    expect(allowedFile(WRITE_ALLOWED, 'lib/reasoning/engine-server.ts')).toBe(true);
    expect(allowedFile(WRITE_ALLOWED, 'lib\\reasoning\\engine-server.ts')).toBe(true);
    expect(allowedFile(WRITE_ALLOWED, 'lib/reasoning/another-engine-server.ts')).toBe(false);
    expect(allowedFile(WRITE_ALLOWED, 'lib\\reasoning\\another-engine-server.ts')).toBe(false);
    expect(greenwichDayWrittenToDateColumn(
      "{ as_of_date: new Date().toISOString().slice(0, 10) }", new Set(['as_of_date']),
    )).toEqual(['as_of_date']);
  });
});
