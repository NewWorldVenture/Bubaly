import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A reward redemption spends the named member's points (rewards) or tokens
 * (economy). Both request actions took the member from the caller, so a child
 * could file a request that - once a parent approved "Sam wants movie night" -
 * spent a sibling's balance. A non-manager now requests only for themselves;
 * 0347 holds RLS to the same.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-a', role: 'child' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const rewards = await import('@/app/(app)/dashboard/rewards/actions');
const economy = await import('@/app/(app)/economy/actions');

describe('requesting a redemption', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    db.seed('rewards', [{ id: 'reward-1', family_id: 'family-1', title: 'Movie night', cost_points: 100 }]);
    db.seed('economy_rewards', [{ id: 'erew-1', family_id: 'family-1', currency_id: 'cur-1', title: 'Ice cream', cost: 5, is_active: true, stock: null }]);
    db.seed('family_members', [
      { id: 'member-a', family_id: 'family-1', role: 'child' },
      { id: 'member-b', family_id: 'family-1', role: 'child' },
    ]);
  });

  it('refuses a child spending a sibling\'s points or tokens, writing nothing', async () => {
    harness.memberId = 'member-a';
    harness.role = 'child';
    expect((await rewards.requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-b' })).ok).toBe(false);
    expect((await economy.requestRedemptionAction({ rewardId: 'erew-1', memberId: 'member-b' })).ok).toBe(false);
    expect(db.table('reward_redemptions')).toEqual([]);
    expect(db.table('economy_redemptions')).toEqual([]);
  });

  it('still lets a child ask for themselves, and a parent ask for a child', async () => {
    harness.memberId = 'member-a';
    harness.role = 'child';
    expect((await rewards.requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-a' })).ok).toBe(true);
    harness.memberId = 'member-p';
    harness.role = 'parent';
    expect((await rewards.requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-b' })).ok).toBe(true);
    expect(db.table('reward_redemptions').map((r) => [r.member_id, r.status])).toEqual([['member-a', 'requested'], ['member-b', 'requested']]);
  });
});
