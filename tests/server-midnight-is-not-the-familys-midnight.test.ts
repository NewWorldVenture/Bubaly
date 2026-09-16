import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `new Date(); d.setHours(0, 0, 0, 0)` is the SERVER's midnight. On a UTC host
// that is 17:00 in California, so a "today" built this way runs 17:00 yesterday
// → 17:00 today: a child opening the kids page after 5pm saw tomorrow's events
// and lost today's, every day. Sydney is worse.
//
// F-017 fixed the kitchen display and left a guard behind, but that guard flags
// one signature — `toISOString().slice(0, 10)` beside a filter on a DATE column.
// These sites use `setHours` against TIMESTAMPTZ columns, so both halves of the
// pattern miss and it reports clean. Its own header calls itself "a floor rather
// than a proof"; this is what was under the floor.
//
// This is a RATCHET, not a proof. Seventeen server-side sites were listed here;
// eleven are now closed and six remain, each needing its own decision about
// which family's day it means. Listing them stops the next one being added
// silently while they are worked down, and shrinking the list is the only edit
// that should ever be made to it.
//
// What is left is deliberately the harder half: every remaining entry is a PURE
// helper that takes a `now` and is called from BOTH server and client code
// (`lib/pantry/logic.ts` has six server callers and two client ones). In a
// client component `new Date()` is the user's own device clock and is already
// right, so these cannot simply be converted — the zone has to be threaded from
// each server caller, or the helper has to take a day key the way
// `weekStrip` now does. `lib/chores/dashboard.ts:dueLabel` is the clearest
// case: its only caller is a client module, so it is listed but may well be
// correct as it stands.
//
// To close one: route it through `dayKeyInTz` / `zonedDayBoundsMs`
// (lib/services/scope.ts), as app/(app)/display/page.tsx and
// app/(app)/kids/page.tsx now do, then DELETE its line here.

const ROOTS = ['app', 'lib', 'components'];

// Known, tracked, and not yet converted. Every entry is a defect waiting for the
// family-zone decision its call site needs — never a site that is fine as it is.
const TRACKED = new Set([
  'lib/capture/parse.ts',
  'lib/chores/dashboard.ts',
  'lib/marketplace/returns.ts',
  'lib/pantry/logic.ts',
  'lib/relationship/dates.ts',
  'lib/routines/detect.ts',
]);

const SERVER_MIDNIGHT = /setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/;

// ── A SECOND SPELLING, which this guard could not see ───────────────────────
//
// `setHours(0,0,0,0)` is one way to say "the host's day". `new Date()
// .toISOString().slice(0, 10)` is another, and the briefing module was written
// in it: `weekWindow` built its window from getUTCFullYear/Month/Date and
// `bucketByDay` took `starts_at.slice(0, 10)`, so a family in Los Angeles
// asking for the week ahead at 6pm was told "today" is tomorrow, and every
// evening event in the Americas was filed on the wrong day. Nine server-side
// sites remain in this spelling and are tracked below; `lib/chores/server.ts`
// was the tenth, and closing it is what this list is for.
//
// A guard that checks ONE spelling of a defect with two is the shape this audit
// keeps finding: it passes, and the thing it is named for goes on happening.
//
// Only the anonymous form is matched — `new Date().toISOString().slice(0,10)`,
// the current instant formatted as a day key — because it needs no dataflow to
// judge. A NAMED date (`now.toISOString().slice(0, 10)`) may already have been
// shifted into the family's zone by its caller, and flagging those put correct
// code on the list when it was tried: a regex pass over that shape returned 28
// sites, of which the first three checked were false positives (a Zod field
// named `at`, and two line numbers that did not point at the code at all).
const HOST_TODAY_KEY = /new Date\(\)\s*\.toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/;

// Known, tracked, and not yet converted — the same rule as TRACKED above.
const TRACKED_TODAY_KEY = new Set([
  'app/(app)/dashboard/auto/actions.ts',
  'app/(app)/dashboard/contacts/[id]/actions.ts',
  'app/(app)/dashboard/home/actions.ts',
  'app/(app)/dashboard/kitchen/actions.ts',
  'app/(app)/dashboard/moments/actions.ts',
  'app/(app)/wallet/hub-actions.ts',
  'app/api/admin/benchmarks/export/route.ts',
  'app/api/cron/wallet-allowance/route.ts',
  'lib/home/asset-detail.ts',
]);

// ── A third shape, EXAMINED and deliberately not tracked ────────────────────
//
// `Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())` appears at
// sixteen server-side sites and is NOT uniformly a defect, which is why it is
// written down here rather than added to a list:
//
//   lib/journal/prompts.ts:dayOfYear   rotates the prompt of the day
//   lib/school/timetable.ts:weekParity picks the A or B week
//
// Both want a STABLE INDEX that every member of the household agrees on, and
// its own comment says so ("fixed epoch so it's stable across the year").
// Making those zone-aware would be a regression, not a fix. Others in the same
// shape are real — `lib/chores/server.ts` was one, and its streak is now counted
// in the family's day. Putting correct code on a defect list is how a list stops
// being read, so this shape needs a per-site decision rather than a ratchet.


// A comment explaining the defect is not the defect. Both files fixed so far
// describe `setHours(0,0,0,0)` in prose immediately above the correct code.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function isClientComponent(source: string): boolean {
  const head = source.slice(0, 200);
  return head.includes("'use client'") || head.includes('"use client"');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('a family day does not turn over at the server\'s midnight', () => {
  const offenders = ROOTS.flatMap((root) => walk(root)).filter((path) => {
    const source = readFileSync(path, 'utf8');
    return !isClientComponent(source) && SERVER_MIDNIGHT.test(withoutComments(source));
  });

  it('finds the tracked set, so the assertions below are measuring something', () => {
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('adds no new server-rendered surface that means the host\'s day', () => {
    expect(offenders.filter((path) => !TRACKED.has(path)).sort()).toEqual([]);
  });

  const todayKeyOffenders = ROOTS.flatMap((root) => walk(root)).filter((path) => {
    const source = readFileSync(path, 'utf8');
    return !isClientComponent(source) && HOST_TODAY_KEY.test(withoutComments(source));
  });

  it('adds no new server-rendered surface that formats the host instant as a day key', () => {
    expect(todayKeyOffenders.filter((path) => !TRACKED_TODAY_KEY.has(path)).sort()).toEqual([]);
  });

  it('keeps the second list honest too', () => {
    const stale = [...TRACKED_TODAY_KEY].filter((path) => !todayKeyOffenders.includes(path)).sort();
    expect(stale, 'these no longer offend; delete them from TRACKED_TODAY_KEY').toEqual([]);
  });

  it('keeps the tracked list honest — an entry that no longer offends must be deleted', () => {
    // A stale allowlist is how a ratchet turns back into a rubber stamp: it
    // would let a REGRESSION into a file that had already been fixed.
    const stale = [...TRACKED].filter((path) => !offenders.includes(path)).sort();
    expect(stale).toEqual([]);
  });

  it('holds the surfaces already converted', () => {
    for (const path of [
      'app/(app)/display/page.tsx',
      'app/(app)/kids/page.tsx',
      'app/(app)/guardian/page.tsx',
      'app/api/ai/wallet/route.ts',
      'components/dashboard/family-dashboard.tsx',
      'components/dashboard/personal-dashboard.tsx',
      'lib/calendar/scheduling.ts',
      'lib/family/signals.ts',
    ]) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(SERVER_MIDNIGHT.test(source), `${path} reverted to the server's midnight`).toBe(false);
      expect(source).toContain('zonedDayBoundsMs');
    }
  });
});
