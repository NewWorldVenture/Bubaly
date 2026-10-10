// A prescription refill alert is told to the person it is prescribed for and to
// the parents — not posted to the whole household.
//
// THE DEFECT. The Autopilot scan (lib/autopilot/scan.ts) turns every active
// medication with a refill date into a suggestion — "Refill Sertraline in 1
// day" — and, because a refill is always urgency 2 or more, sends it as a
// notification with `recipients: 'family'`. In the notifications service that
// is ONE row with a NULL user_id, which every member reads in their bell and
// which the push/email crons deliver to every member: the children, a teen, the
// babysitter (caregiver), a guest. The nightly run is the cron's, on the
// SERVICE client, so not even 0465 (a child reads only their own prescriptions)
// would stop it; the scan reads every member's medications whatever RLS says.
//
// The product rule is F-G09: a non-manager sees the prescriptions written for
// them. The Medications page, the Family Health page and the health coach keep
// it in app code; this alert did not.
//
// WHAT IS ASSERTED, against the real scan over an in-memory database: a
// parent's refill reaches the parents and adults only; a child's reaches that
// child and the managers, never a sibling, caregiver or guest; no refill alert
// is a family-wide row. If the household cannot be read, the alert is not sent
// at all rather than falling back to everyone. A renewal (not a prescription)
// still goes to the family, as before.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'f1';
const NOW = new Date('2026-10-10T12:00:00Z');
const t = (key: string) => key;

let db: InMemorySupabase & SupabaseClient<Database>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
  db.seed('families', [{ id: FAMILY, name: 'Fam', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'm-mom', family_id: FAMILY, user_id: 'u-mom', role: 'parent', is_active: true, display_name: 'Mom' },
    { id: 'm-dad', family_id: FAMILY, user_id: 'u-dad', role: 'adult', is_active: true, display_name: 'Dad' },
    { id: 'm-kid', family_id: FAMILY, user_id: 'u-kid', role: 'child', is_active: true, display_name: 'Kid' },
    { id: 'm-teen', family_id: FAMILY, user_id: 'u-teen', role: 'teen', is_active: true, display_name: 'Teen' },
    { id: 'm-sitter', family_id: FAMILY, user_id: 'u-sitter', role: 'caregiver', is_active: true, display_name: 'Sitter' },
    { id: 'm-guest', family_id: FAMILY, user_id: 'u-guest', role: 'guest', is_active: true, display_name: 'Guest' },
    { id: 'm-gone', family_id: FAMILY, user_id: 'u-gone', role: 'parent', is_active: false, display_name: 'Former' },
  ]);
});

const scan = () => runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', t, NOW);
const prescription = (memberId: string | null, name: string) => db.seed('medications', [{
  id: `med-${name}`, family_id: FAMILY, member_id: memberId, name, is_active: true,
  refill_on: '2026-10-11', refill_reminder_days: 7,
}]);

/** Who can read a notification naming `word`: a NULL user_id is everyone. */
function readersOf(word: string): (string | null)[] {
  return db.table('notifications').filter((n) => String(n.title).includes(word)).map((n) => n.user_id as string | null).sort();
}

describe('a refill alert', () => {
  it("for a parent's prescription reaches the parents and adults only", async () => {
    prescription('m-mom', 'Sertraline');
    await scan();
    expect(db.table('autopilot_suggestions').map((s) => s.title)).toEqual(['Refill Sertraline in 1 day']);
    expect(readersOf('Sertraline')).toEqual(['u-dad', 'u-mom']);
  });

  it("for a child's prescription reaches that child and the managers, not a sibling, sitter or guest", async () => {
    prescription('m-kid', 'Methylphenidate');
    await scan();
    expect(readersOf('Methylphenidate')).toEqual(['u-dad', 'u-kid', 'u-mom']);
  });

  it('for a prescription with no member reaches the managers', async () => {
    prescription(null, 'Epinephrine');
    await scan();
    expect(readersOf('Epinephrine')).toEqual(['u-dad', 'u-mom']);
  });

  it('is never a family-wide row', async () => {
    prescription('m-mom', 'Sertraline');
    prescription('m-teen', 'Isotretinoin');
    await scan();
    expect(db.table('notifications').filter((n) => n.user_id === null)).toEqual([]);
    for (const user of ['u-sitter', 'u-guest', 'u-gone']) expect(readersOf(''), user).not.toContain(user);
  });

  it('is not sent at all when the household cannot be read, rather than sent to everyone', async () => {
    prescription('m-mom', 'Sertraline');
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      const builder = from(name as never) as unknown as { select: (columns?: string) => unknown };
      if (name === 'family_members') {
        const select = builder.select.bind(builder);
        builder.select = (columns?: string) => (columns === 'id, role'
          ? { eq: () => ({ eq: () => Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom', details: null, hint: null } }) }) }
          : select(columns));
      }
      return builder;
    }) as never);
    await scan();
    expect(readersOf('Sertraline')).toEqual([]);
  });
});

describe('an alert that is not a prescription', () => {
  it('still goes to the whole family, as before', async () => {
    db.seed('renewals', [{ id: 'r1', family_id: FAMILY, title: 'Passport', status: 'active', expires_at: '2026-10-10' }]);
    await scan();
    expect(readersOf('Passport')).toEqual([null]);
  });
});
