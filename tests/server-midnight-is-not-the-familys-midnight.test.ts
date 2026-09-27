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
// fifteen are now closed and two remain, each needing its own decision about
// which family's day it means. Listing them stops the next one being added
// silently while they are worked down, and shrinking the list is the only edit
// that should ever be made to it.
//
// What is left is deliberately the harder half: every remaining entry is a PURE
// helper that takes a `now` and is called from BOTH server and client code. In a
// client component `new Date()` is the user's own device clock and is already
// right, so these cannot simply be converted — the zone has to be threaded from
// each server caller, or the helper has to take a day key the way
// `weekStrip` now does.
//
// This list used to name `lib/chores/dashboard.ts:dueLabel` as "the clearest
// case: its only caller is a client module, so it is listed but may well be
// correct as it stands". That note was WRONG, and it is worth leaving the
// correction here rather than quietly deleting it, because the reasoning it
// encodes — "a client's own clock is already right" — is what kept three of
// these entries on the list unexamined. `due_at` is a timestamptz, and the
// rest of the app reads it in the FAMILY's zone; a client that reads it in the
// device's is not correct, it is a second opinion. The test for it now asserts
// two zones giving two different answers about the same instant.
//
// `lib/pantry/logic.ts` was the worked example of the harder half, and the
// answer turned out NOT to be "the device clock is fine on the client". It had
// six server callers and two client ones, and leaving the client pair on the
// device clock would have given a family two different answers to "does this
// expire today" — the server-rendered kitchen page and the client-rendered
// pantry module disagreeing about the same jar. So it takes a required
// `todayKey: string` and has no default at all, and BOTH sides answer it from
// `families.timezone`: the server via `todayKeyFor(ctx)`, the client via
// `dayKeyIn(new Date(), family.timezone)`. `lib/food/leftovers.ts` went with it,
// since it subtracts days through the same helper.
//
// `lib/marketplace/returns.ts` followed, and it is the one where the cost of
// being a day out is not cosmetic: its cron is CROSS-FAMILY, and its dedupe
// stamps are one-shot, so a reminder keyed to the host's day does not arrive
// late — it spends the only reminder that order will ever get. Its ordering is
// pinned in tests/cron-return-reminders-boundary.test.ts, because the version
// that shipped already resolved each family's scope, just one step too late to
// be the thing that answered "is this due today".
//
// `lib/relationship/dates.ts` is the one where the ratchet's own premise was
// wrong. Its header read "Deterministic (inject `from`) so it's fully
// unit-testable", which was true and beside the point: every one of its four
// call sites took the DEFAULT, and the default was the server's clock. A
// parameter only ever injected by tests is not a seam, it is a comment. All
// four sites already held the family's zone — two of them compute `todayKey`
// in the same function and use it for everything else — so the fix was to
// delete the default and pass what was already there.
//
// To close one: route it through `dayKeyInTz` / `zonedDayBoundsMs`
// (lib/services/scope.ts), as app/(app)/display/page.tsx and
// app/(app)/kids/page.tsx now do, then DELETE its line here.

const ROOTS = ['app', 'lib', 'components'];

// Tracked, and NOT all for the same reason — which this list used to claim, in
// the words "Every entry is a defect waiting for the family-zone decision its
// call site needs — never a site that is fine as it is."
//
// That was true of fifteen of the original seventeen and is true of NEITHER
// survivor. The sibling list below had exactly this header and exactly this
// problem, and it was split by reason two passes ago; leaving this one
// unsplit would hand the next person a list that says "go convert these" about
// two sites where converting is the wrong move.
//
// EXAMINED AND DELIBERATE — do not convert without a decision to go with it:
//
//   • lib/capture/parse.ts — the `setHours` lives in LOCAL_OPS, one half of a
//     deliberate LOCAL/UTC pair whose own header explains the split at length:
//     a wall clock carried in LOCAL date fields is normalised by the runtime's
//     DST rules, so the server bridge anchors it in UTC, while the BROWSER
//     keeps local because a person typing "tomorrow at 6pm" means 6pm where
//     they are standing. The browser path is correct as it stands.
//     Its one server-reachable leak WAS real and is fixed:
//     lib/ai/context/intents.ts called `parseEvent(q, now)` with no options and
//     serialised the resolved instant onto the calendar. Note that `parseEvent`
//     still DEFAULTS to LOCAL_OPS, so a future server caller can reintroduce
//     that leak silently — the defect was never in this file, and converting it
//     would not have prevented it.
//
//   • lib/routines/detect.ts — `materializeRoutine` builds calendar events from
//     a device-local Monday, and the entire calendar grid it feeds is ALSO
//     device-local (`weekStart(weekOffset)` in components/modules/
//     calendar-module.tsx). Converting only this helper would make a routine's
//     events land at times that disagree with the grid the user just clicked
//     in — worse than what is there now. Whether that whole module should
//     render in the family's zone is a real product decision, and not one to
//     make under cover of a one-line timezone fix.
//
// So this list is now a RECORD, not a queue. A new entry appearing here is
// still a regression to look at; these two are not work waiting to be done.
const TRACKED = new Set([
  'lib/capture/parse.ts',
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
// evening event in the Americas was filed on the wrong day. Ten server-side
// sites were found in this spelling; seven are closed and the three that remain
// are examined and deliberate, which the list below says one by one.
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

// Still on the list, and NOT all for the same reason — which the `setHours`
// list above gets to claim ("never a site that is fine as it is") and this one
// cannot. Reading the six defects out of it and leaving three behind without
// saying why would leave the next person to work this list "fixing" an
// allowance cron and changing when money is paid.
//
// EXAMINED AND DELIBERATE — do not convert without a decision to go with it:
//
//   app/api/cron/wallet-allowance/route.ts
//     Platform-wide. Its own comment states the trade: resolving every rule's
//     family zone to decide whether its day has arrived, against a cost bounded
//     at one day early for families west of UTC. A per-family run date is the
//     fix if allowance timing ever has to be exact.
//
//   app/api/admin/benchmarks/export/route.ts
//     A day stamp on a site-admin export. There is no family in scope, so the
//     host's day is the only day there is.
//
//   lib/home/asset-detail.ts
//     Takes an injected `today` and falls back. It is a pure function whose
//     doc says "no client, no I/O"; if a caller is passing nothing, the defect
//     is at that caller, not here.
//
// The six that WERE defects — a date column defaulted to the host's day in a
// server action holding a user context — are closed: auto and home service
// records, a contact interaction, a wallet transaction, the kitchen food-score
// snapshot, and `moment_activations.as_of_date`, whose own caller says "hide a
// moment for the rest of TODAY" and wrote tomorrow's row.
const TRACKED_TODAY_KEY = new Set([
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
