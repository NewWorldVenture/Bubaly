// Call-level role tests for the insight-of-the-day actions
// (app/(app)/dashboard/insight-actions.ts), Register B rows
// ACTION-F86C1B82654C (dismiss) and ACTION-632D1C4485C5 (act).
//
// THE POLICY, from the sources and not from the action:
//   - 0141_daily_insights.sql:47-49: daily_insights_update is
//     is_family_member(family_id), and no later migration narrows it.
//   - components/dashboard/ai-home-dashboard.tsx:465-556: the rows are the
//     household's, and a reader who is not a parent or adult is shown their own
//     reading "under the day's active row of the same kind: its id is what a
//     dismissal marks". So the hero offers Dismiss (components/dashboard/
//     insight-hero.tsx:49) to every member, and the dismiss marks the row.
//   - The action's own header: family-scoped, any member of the family.
// So a parent, adult, teen, child or caregiver of the family sets the status;
// an id from another family is refused as invalid and changes nothing.
//
// A GUEST IS NOT PINNED HERE. The RLS and the page let a guest dismiss, while
// the household-roles rule app/(app)/dashboard/knowledge/actions.ts:41-45
// cites ("a guest views ... and does not write ... as every other household
// write refuses one") says a guest does not change the household's rows. The
// sources disagree, so it is recorded for an owner decision, not asserted.
//
// The real exported actions run against tests/helpers/in-memory-supabase.ts;
// only the signed-in context, the translator (key in, key out) and next/cache
// are stubbed. The fake has no RLS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  db: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { dismissInsightAction, actOnInsightAction } = await import('@/app/(app)/dashboard/insight-actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const INSIGHT_A = '00000000-0000-4000-8000-0000000003a1';
const INSIGHT_B = '00000000-0000-4000-8000-0000000003b1';
const INVALID = 'insightActions.invalidInsight';

const MEMBERS = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, role, family: { id: FAMILY_A, timezone: 'UTC' }, member: { id: `member-${role}` } },
  });
}

const rows = () => structuredClone(db.table('daily_insights'));
const status = (id: string) => db.table('daily_insights').find((r) => r.id === id)?.status;

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  db.seed('daily_insights', [
    { id: INSIGHT_A, family_id: FAMILY_A, as_of_date: '2026-11-12', kind: 'conflict', title: 'Two events', status: 'active', member_id: null },
    { id: INSIGHT_B, family_id: FAMILY_B, as_of_date: '2026-11-12', kind: 'conflict', title: 'Two events', status: 'active', member_id: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  { id: 'ACTION-F86C1B82654C', name: 'dismissInsightAction', run: dismissInsightAction, writes: 'dismissed' },
  { id: 'ACTION-632D1C4485C5', name: 'actOnInsightAction', run: actOnInsightAction, writes: 'acted' },
])('$name', ({ id, run, writes }) => {
  it.each(MEMBERS)(`${id} the %s of the family marks the household's insight ${writes}, and only that row`, async (role) => {
    signInAs(role);
    expect(await run(INSIGHT_A)).toEqual({ ok: true });
    expect(status(INSIGHT_A)).toBe(writes);
    expect(status(INSIGHT_B)).toBe('active');
    expect(db.table('daily_insights')).toHaveLength(2);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard');
  });

  it(`${id} a parent naming another family's insight is told it is invalid, and neither family's row changes`, async () => {
    signInAs('parent');
    const before = rows();
    expect(await run(INSIGHT_B)).toEqual({ ok: false, error: INVALID });
    expect(rows()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it(`${id} an empty id is refused before the session is read`, async () => {
    signInAs('parent');
    const before = rows();
    expect(await run('')).toEqual({ ok: false, error: INVALID });
    expect(rows()).toEqual(before);
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
  });

  it(`${id} a signed-out caller is stopped at the session and writes nothing`, async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = rows();
    await expect(run(INSIGHT_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(rows()).toEqual(before);
  });
});
