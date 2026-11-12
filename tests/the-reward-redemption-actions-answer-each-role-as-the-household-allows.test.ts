// The two reward redemption actions, called the way the rewards and chores
// pages call them, by every household role, with valid input and with another
// family's ids.
//
// THE POLICY, from the sources rather than from the action:
//   - A member asks for a reward with their OWN points; only a manager asks on
//     someone else's behalf: the live insert policy
//     (supabase/migrations/0373_a_redemption_spends_your_own_points.sql:40-41,
//     `is_self_member(member_id) or can_manage_family(family_id)`) and the
//     action's comment (app/(app)/dashboard/rewards/actions.ts:61-64).
//   - A manager redeeming for themselves takes it at once; everything else
//     queues as 'requested' (actions.ts:96-99). The title and price are the
//     reward's, never the caller's (0028's snapshot, actions.ts:44-51).
//   - Deciding is a manager's (actions.ts:141 "Managers only"; 0373:49-53's
//     update policy lets a non-manager touch only their own still-requested
//     row, and only to 'requested' or 'cancelled').
//   - The reward, the member and the redemption must all be the caller's
//     family (actions.ts:73-90, the `.eq('family_id', …)` on every read and on
//     the decision write).
//
// NOT PINNED (see the PR body, "Needs an owner decision"): a caregiver's or a
// guest's request for themselves. The insert policy and the chores page
// (components/modules/chores-module.tsx:432) let any member redeem for
// themselves; the rewards page offers Redeem only to a child or a teen
// (components/modules/rewards-module.tsx:337). Nor the plan: /dashboard/rewards
// is a Plus feature (lib/constants/feature-catalog.ts:49) while the free chores
// page offers the same request.
//
// Mocked: the session, the server client factory, next/cache and the
// translator. The points ledger (0439's trigger) is not modelled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { FAMILY_A, FAMILY_B, memberIdOf, memberRows, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { requestRedemptionAction, decideRedemptionAction } = await import('@/app/(app)/dashboard/rewards/actions');

const NOW = '2026-11-12T15:00:00.000Z';
const NOT_AVAILABLE = 'That reward is not available.';
const PARENTS_ONLY = 'Only a parent/guardian can do this.';
const REWARD_A = 'a0000000-0000-4000-8000-0000000a0401';
const REWARD_B = 'b0000000-0000-4000-8000-0000000b0401';
const REQUESTED_A = 'a0000000-0000-4000-8000-0000000a0402';
const APPROVED_A = 'a0000000-0000-4000-8000-0000000a0403';
const REQUESTED_B = 'b0000000-0000-4000-8000-0000000b0402';

const MANAGERS: Caller[] = ['parent', 'adult'];
const CHILDREN: Caller[] = ['teen', 'child', 'kid'];
const NOT_MANAGERS: Caller[] = ['teen', 'child', 'kid', 'caregiver', 'guest'];

let db: InMemorySupabase;
const redemptions = () => db.table('reward_redemptions');
const redemption = (id: string) => redemptions().find((r) => r.id === id) as Row | undefined;
const seeded = (id: string) => redemptions().filter((r) => r.id !== id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase();
  harness.db = db;
  harness.caller = 'parent';
  harness.revalidatePath = [];
  db.seed('family_members', [...memberRows(FAMILY_A), ...memberRows(FAMILY_B)]);
  db.seed('rewards', [
    { id: REWARD_A, family_id: FAMILY_A, title: 'Movie night pick', cost_points: 50 },
    { id: REWARD_B, family_id: FAMILY_B, title: 'Their reward', cost_points: 10 },
  ]);
  db.seed('reward_redemptions', [
    { id: REQUESTED_A, family_id: FAMILY_A, reward_id: REWARD_A, member_id: memberIdOf('child'), reward_title: 'Movie night pick', cost_points: 50, status: 'requested', decided_by: null, decided_at: null },
    { id: APPROVED_A, family_id: FAMILY_A, reward_id: REWARD_A, member_id: memberIdOf('teen'), reward_title: 'Movie night pick', cost_points: 50, status: 'approved', decided_by: memberIdOf('parent'), decided_at: '2026-11-11T12:00:00.000Z' },
    { id: REQUESTED_B, family_id: FAMILY_B, reward_id: REWARD_B, member_id: memberIdOf('child', FAMILY_B), reward_title: 'Their reward', cost_points: 10, status: 'requested', decided_by: null, decided_at: null },
  ]);
});

afterEach(() => { vi.useRealTimers(); });

const as = (caller: Caller | null) => { harness.caller = caller; };
/** The rows a call added, as the caller would see them in history. */
const added = () => redemptions().filter((r) => ![REQUESTED_A, APPROVED_A, REQUESTED_B].includes(r.id as string));

describe('requestRedemptionAction (ACTION-82773087CA67)', () => {
  it.each(CHILDREN)('ACTION-82773087CA67 a %s asks for a reward with their own points, and it waits for a parent', async (caller) => {
    as(caller);
    const result = await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf(caller) });

    expect(added()).toEqual([expect.objectContaining({
      family_id: FAMILY_A, reward_id: REWARD_A, member_id: memberIdOf(caller),
      reward_title: 'Movie night pick', cost_points: 50, status: 'requested', decided_by: null, decided_at: null,
    })]);
    expect(result).toEqual({ ok: true, id: added()[0].id });
    expect(harness.revalidatePath).toEqual(['/dashboard/rewards', '/dashboard/chores']);
  });

  it.each(CHILDREN)("ACTION-82773087CA67 a %s may not spend a sibling's points", async (caller) => {
    as(caller);
    const sibling = memberIdOf(caller === 'teen' ? 'child' : 'teen');
    expect(await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: sibling })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(added()).toEqual([]);
    // Refused from the session alone, before the database is asked anything.
    expect(db.log).toEqual([]);
  });

  it.each(['caregiver', 'guest'] as Caller[])("ACTION-82773087CA67 a %s may not spend a child's points", async (caller) => {
    as(caller);
    expect(await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf('child') })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(added()).toEqual([]);
    expect(db.log).toEqual([]);
  });

  it.each(MANAGERS)('ACTION-82773087CA67 a %s redeeming for themselves takes the reward at once, decided by them', async (caller) => {
    as(caller);
    const result = await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf(caller) });

    expect(added()).toEqual([expect.objectContaining({
      member_id: memberIdOf(caller), status: 'approved', decided_by: memberIdOf(caller), decided_at: NOW, cost_points: 50,
    })]);
    expect(result).toEqual({ ok: true, id: added()[0].id });
  });

  it.each(MANAGERS)("ACTION-82773087CA67 a %s may ask on a child's behalf, and it still waits", async (caller) => {
    as(caller);
    expect(await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf('child') })).toEqual({ ok: true, id: expect.any(String) });
    expect(added()).toEqual([expect.objectContaining({ member_id: memberIdOf('child'), status: 'requested', decided_by: null })]);
  });

  it("ACTION-82773087CA67 another family's reward is not available to a parent, and nothing is written", async () => {
    const before = structuredClone(redemptions());
    expect(await requestRedemptionAction({ rewardId: REWARD_B, forMemberId: memberIdOf('parent') })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(redemptions()).toEqual(before);
  });

  it("ACTION-82773087CA67 a parent may not spend a member of another family's points", async () => {
    const before = structuredClone(redemptions());
    expect(await requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf('child', FAMILY_B) })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(redemptions()).toEqual(before);
  });

  it('ACTION-82773087CA67 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    await expect(requestRedemptionAction({ rewardId: REWARD_A, forMemberId: memberIdOf('child') })).rejects.toThrow('NEXT_REDIRECT');
    expect(added()).toEqual([]);
  });
});

describe('decideRedemptionAction (ACTION-B1F1A5BB67EA)', () => {
  it.each(MANAGERS)("ACTION-B1F1A5BB67EA a %s approves a child's request, decided by them", async (caller) => {
    as(caller);
    expect(await decideRedemptionAction({ id: REQUESTED_A, decision: 'approved' })).toEqual({ ok: true, id: REQUESTED_A });
    expect(redemption(REQUESTED_A)).toEqual(expect.objectContaining({ status: 'approved', decided_by: memberIdOf(caller), decided_at: NOW }));
    expect(seeded(REQUESTED_A).map((r) => r.status)).toEqual(['approved', 'requested']);
  });

  it.each(MANAGERS)('ACTION-B1F1A5BB67EA a %s marks an approved reward fulfilled', async (caller) => {
    as(caller);
    expect(await decideRedemptionAction({ id: APPROVED_A, decision: 'fulfilled' })).toEqual({ ok: true, id: APPROVED_A });
    expect(redemption(APPROVED_A)).toEqual(expect.objectContaining({ status: 'fulfilled', decided_by: memberIdOf(caller) }));
  });

  it.each(NOT_MANAGERS)('ACTION-B1F1A5BB67EA a %s may not approve, reject or fulfil, and nothing moves', async (caller) => {
    as(caller);
    const before = structuredClone(redemptions());
    expect(await decideRedemptionAction({ id: REQUESTED_A, decision: 'approved' })).toEqual({ ok: false, error: PARENTS_ONLY });
    expect(await decideRedemptionAction({ id: REQUESTED_A, decision: 'rejected' })).toEqual({ ok: false, error: PARENTS_ONLY });
    expect(await decideRedemptionAction({ id: APPROVED_A, decision: 'fulfilled' })).toEqual({ ok: false, error: PARENTS_ONLY });
    expect(redemptions()).toEqual(before);
  });

  it("ACTION-B1F1A5BB67EA another family's request is not available to a parent, and neither family's rows move", async () => {
    const before = structuredClone(redemptions());
    expect(await decideRedemptionAction({ id: REQUESTED_B, decision: 'approved' })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(redemptions()).toEqual(before);
  });

  it('ACTION-B1F1A5BB67EA a request cannot be fulfilled without having been approved', async () => {
    const before = structuredClone(redemptions());
    expect(await decideRedemptionAction({ id: REQUESTED_A, decision: 'fulfilled' })).toEqual({ ok: false, error: NOT_AVAILABLE });
    expect(redemptions()).toEqual(before);
  });

  it('ACTION-B1F1A5BB67EA a signed-out caller is sent to sign in and nothing moves', async () => {
    as(null);
    const before = structuredClone(redemptions());
    await expect(decideRedemptionAction({ id: REQUESTED_A, decision: 'approved' })).rejects.toThrow('NEXT_REDIRECT');
    expect(redemptions()).toEqual(before);
  });
});
