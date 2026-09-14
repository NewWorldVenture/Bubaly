import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `settleAll` exists so one failed read cannot reject a page's whole batch. It
// answers `{ data: null, error }` — and `lib/supabase/settle.ts` says why that
// distinction matters. A page that destructures `{ data }` and drops `error`
// throws the distinction away: `data` is null, the list renders empty, and an
// OUTAGE is presented to the user as a FACT about their family.
//
// The repo already states the principle, on the page that gets it right:
//
//   "A dropped error would tell the child 'All done! 🎉 No jobs left today.'
//    and '0 points earned' when they actually have chores and points — a
//    reassuring-but-wrong, motivation-affecting lie."   — kids/page.tsx
//
// Two pages where the empty state is a positive CLAIM rather than an absence
// are fixed: /dashboard/conflicts said "no conflicts" — on the page whose whole
// job is finding them — and /dashboard/family-access said a family has no kid
// logins and offered to create them, about an access-control record.
//
// This is a RATCHET for the rest. Fourteen remain; most are display lists where
// an empty render is a display bug rather than a false claim, and each needs its
// own translated error string, which is a translation task rather than a code
// one. Listing them stops a fifteenth appearing while they are worked down.
// Shrinking the list is the only edit it should ever receive.

const TRACKED = new Set([
  'app/(app)/dashboard/app-store/page.tsx',
  'app/(app)/dashboard/auto/licenses/page.tsx',
  'app/(app)/dashboard/auto/vehicles/page.tsx',
  'app/(app)/dashboard/moments/page.tsx',
  'app/(app)/dashboard/social-feed/page.tsx',
  'app/(app)/dashboard/social/content-studio/page.tsx',
  'app/(app)/family/activity/page.tsx',
  'app/(app)/feedback/page.tsx',
  'app/(app)/guardian/contacts/page.tsx',
  'app/(app)/guardian/settings/page.tsx',
  'app/(app)/marketplace/insights/page.tsx',
  'app/(app)/marketplace/questions/page.tsx',
  'app/(app)/marketplace/store/page.tsx',
  'app/api/ai/savings/route.ts',
]);

// Any mention of an error is enough to clear the ratchet: this measures "did the
// author consider the failure at all", not the shape of the handling.
const LOOKS_AT_THE_ERROR = /\.error\b|Error\b\s*\?\?|\berror:\s*\w+Error/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry === 'page.tsx' || entry === 'route.ts') out.push(path);
  }
  return out;
}

describe('a failed read is not an empty table', () => {
  const droppers = walk('app').filter((path) => {
    const source = readFileSync(path, 'utf8');
    if (source.slice(0, 100).includes("'use client'")) return false;
    if (!source.includes('settleAll(') && !source.includes('settle(')) return false;
    return !LOOKS_AT_THE_ERROR.test(source);
  });

  it('finds the settle-using server surfaces, so the assertions below measure something', () => {
    const users = walk('app').filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('settleAll(') || source.includes('settle(');
    });
    expect(users.length).toBeGreaterThan(50);
  });

  it('adds no new server surface that reads through settle and ignores the error', () => {
    expect(droppers.filter((path) => !TRACKED.has(path)).sort()).toEqual([]);
  });

  it('keeps the tracked list honest — an entry that now handles its error must be deleted', () => {
    // A stale allowlist is how a ratchet becomes a rubber stamp: it would
    // readmit a regression into a page that had already been fixed.
    expect([...TRACKED].filter((path) => !droppers.includes(path)).sort()).toEqual([]);
  });

  it('holds the two pages whose empty state was a claim, not an absence', () => {
    for (const path of [
      'app/(app)/dashboard/conflicts/page.tsx',
      'app/(app)/dashboard/family-access/page.tsx',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(LOOKS_AT_THE_ERROR.test(source), `${path} went back to dropping its read error`).toBe(true);
      expect(source).toContain('<ErrorState');
    }
  });
});
