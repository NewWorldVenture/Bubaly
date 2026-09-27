import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseActiveMembership } from '@/lib/auth/active-membership';

// DATA-019. With no stored preference naming one of a user's families, each
// resolver took row 0 of an unordered query. Postgres returns that in heap
// order, and an UPDATE moves the row's new version to the end of the heap, so
// renaming a member in one family moved which family they landed in —
// measured on the local database: Home,Second -> Second,Home after a
// display-name edit on the Home row.

const HOME = { family_id: '00000000-0000-4000-8000-0000000000a1', created_at: '2026-01-10T09:00:00+00:00' };
const SECOND = { family_id: '00000000-0000-4000-8000-0000000000b2', created_at: '2026-05-02T18:30:00.123456+00:00' };

describe('chooseActiveMembership', () => {
  it('gives the same family whichever order the rows arrive in', () => {
    expect(chooseActiveMembership([HOME, SECOND], null)).toBe(HOME);
    expect(chooseActiveMembership([SECOND, HOME], null)).toBe(HOME);
  });

  it('honours a preference that names one of the families', () => {
    expect(chooseActiveMembership([HOME, SECOND], SECOND.family_id)).toBe(SECOND);
  });

  it('falls back to the earliest when the preference names a family they left', () => {
    expect(chooseActiveMembership([SECOND, HOME], '00000000-0000-4000-8000-0000000000c3')).toBe(HOME);
  });

  it('compares instants, not strings, across offsets', () => {
    const earlierButLaterAsText = { family_id: '00000000-0000-4000-8000-0000000000d4', created_at: '2026-01-10T10:00:00+02:00' };
    expect(chooseActiveMembership([HOME, earlierButLaterAsText], null)).toBe(earlierButLaterAsText);
  });

  it('breaks a timestamp tie on the family id, and puts an unknown age last', () => {
    const twin = { family_id: '00000000-0000-4000-8000-000000000000', created_at: HOME.created_at };
    expect(chooseActiveMembership([HOME, twin], null)).toBe(twin);
    const undated = { family_id: '00000000-0000-4000-8000-000000000001' };
    expect(chooseActiveMembership([undated, SECOND], null)).toBe(SECOND);
  });

  it('has nothing to choose from an empty list', () => {
    expect(chooseActiveMembership([], HOME.family_id)).toBeUndefined();
  });
});

describe('every resolver of the active family makes the same choice', () => {
  // The document-link check compares its answer to the cookie context's, and
  // the billing gate judges whichever family it picks, so a resolver with its
  // own fallback would disagree with the others again.
  const RESOLVERS = [
    'lib/supabase/auth.ts',
    'lib/supabase/bearer.ts',
    'lib/server/entitlement.ts',
    'lib/services/paperwork/link-access.ts',
  ];

  it.each(RESOLVERS)('%s chooses through chooseActiveMembership', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/chooseActiveMembership\(/);
    expect(src).not.toMatch(/active_family_id\)\s*\?\?\s*\w+(\.data)?\[0\]/);
  });

  it('the resolvers that select columns read created_at, which the choice needs', () => {
    expect(readFileSync('lib/server/entitlement.ts', 'utf8')).toMatch(/select\('family_id, created_at'\)/);
    expect(readFileSync('lib/services/paperwork/link-access.ts', 'utf8')).toMatch(/select\('id, family_id, user_id, role, is_active, created_at'/);
  });
});
