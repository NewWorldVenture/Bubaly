import { describe, expect, it } from 'vitest';
import { chooseActiveMembership } from '@/lib/auth/active-membership';
import { pickActiveFamily, resolveActiveFamily, type MembershipRow } from '@/mobile/src/lib/family';
import type { Db } from '@/mobile/src/lib/db';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// The phone picks its own active family, then SENDS it: /api/ai and
// /api/calendar/occurrences take `X-Bubaly-Family-Id` as an assertion of the
// server's bearer context and answer 409 when the two disagree.
//
// DATA-019 gave every server resolver one rule for a user whose preference
// names none of their families — the EARLIEST membership — because row 0 of an
// unordered query is heap order, and an UPDATE (a display-name edit) moves a
// row to the end of the heap. The mobile resolver was never moved onto it: it
// still took row 0, and did not even select `created_at`. A two-family account
// with no usable preference whose rows came back newer-first therefore had the
// phone on one family and the bearer context on the other. Every assistant
// turn came back "family_changed" and the calendar "Calendar account changed",
// with nothing the person could do on the phone to fix it.

const USER = 'user-1';
const HOME = '00000000-0000-4000-8000-0000000000a1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [
    { id: HOME, name: 'Home', timezone: 'America/Chicago' },
    { id: SECOND, name: 'Second', timezone: 'Europe/London' },
  ]);
  // Heap order: the Home row was edited last, so it comes back second.
  // (`families_id` only lets the fake resolve the `families(...)` embed, which
  // it follows through `<alias>_id`; the real foreign key is family_id. The
  // projection returns selected columns only, so it never reaches the code.)
  db.seed('family_members', [
    { id: 'member-second', family_id: SECOND, families_id: SECOND, user_id: USER, role: 'adult', display_name: 'Dana', is_active: true, created_at: '2026-05-02T18:30:00.123456+00:00' },
    { id: 'member-home', family_id: HOME, families_id: HOME, user_id: USER, role: 'parent', display_name: 'Dana', is_active: true, created_at: '2026-01-10T09:00:00+00:00' },
  ]);
  return db;
}

describe('the phone lands on the family the server will check it against', () => {
  it('with no stored preference, picks the earliest membership, not the first row', async () => {
    const db = household();
    const serverChoice = chooseActiveMembership(db.table('family_members') as { family_id: string; created_at: string }[], null);
    expect(serverChoice?.family_id).toBe(HOME);

    const phone = await resolveActiveFamily(db as unknown as Db, USER);
    expect(phone?.familyId).toBe(HOME);
    expect(phone?.memberId).toBe('member-home');
    expect(phone?.timezone).toBe('America/Chicago');
  });

  it('with a preference naming a family the user has left, falls back to the earliest too', async () => {
    const db = household();
    db.seed('user_preferences', [{ user_id: USER, active_family_id: '00000000-0000-4000-8000-0000000000c3' }]);
    expect((await resolveActiveFamily(db as unknown as Db, USER))?.familyId).toBe(HOME);
  });

  it('still honours a preference that names one of the families', async () => {
    const db = household();
    db.seed('user_preferences', [{ user_id: USER, active_family_id: SECOND }]);
    expect((await resolveActiveFamily(db as unknown as Db, USER))?.familyId).toBe(SECOND);
  });

  it('pickActiveFamily agrees with chooseActiveMembership whatever order the rows arrive in', () => {
    const rows: MembershipRow[] = [
      { id: 'member-second', family_id: SECOND, role: 'adult', display_name: 'Dana', created_at: '2026-05-02T18:30:00Z', families: { name: 'Second', timezone: null } },
      { id: 'member-home', family_id: HOME, role: 'parent', display_name: 'Dana', created_at: '2026-01-10T09:00:00Z', families: { name: 'Home', timezone: null } },
    ];
    expect(pickActiveFamily(rows, null)?.familyId).toBe(HOME);
    expect(pickActiveFamily([...rows].reverse(), null)?.familyId).toBe(HOME);
  });
});
