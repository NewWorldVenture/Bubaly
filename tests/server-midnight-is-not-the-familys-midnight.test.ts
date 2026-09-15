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
