import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A child asks to spend their OWN tokens (DATA-004's economy sibling).
 *
 * economy_decide_redemption is atomic — it locks the request, re-checks the
 * balance and debits in one transaction — so the approval cannot overspend. The
 * request is where the gap was: the action checked only that the member was in
 * the family, so a child could queue a redemption against a sibling's tokens for
 * a parent to approve at a glance. A manager may still ask on anyone's behalf.
 */

const FAMILY = 'family-1';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'child', memberId: 'member-child' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'someone@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY,
      role: state.role,
      member: { id: state.memberId, family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

const { requestRedemptionAction } = await import('@/app/(app)/economy/actions');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>();
  db.seed('economy_rewards', [{ id: 'reward-1', family_id: FAMILY, currency_id: 'cur-1', title: 'Pizza night', cost: 10, is_active: true, stock: null }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, user_id: 'user-2', role: 'child', is_active: true },
    { id: 'member-sibling', family_id: FAMILY, user_id: 'user-3', role: 'child', is_active: true },
  ]);
  db.seed('currency_transactions', [
    { id: 't1', family_id: FAMILY, currency_id: 'cur-1', member_id: 'member-child', direction: 'credit', amount: 50 },
    { id: 't2', family_id: FAMILY, currency_id: 'cur-1', member_id: 'member-sibling', direction: 'credit', amount: 50 },
  ]);
  state.db = db;
  state.role = 'child';
  state.memberId = 'member-child';
});

describe('an economy redemption spends the asker’s own tokens', () => {
  it('lets a child ask for themselves', async () => {
    const result = await requestRedemptionAction({ rewardId: 'reward-1', memberId: 'member-child' });
    expect(result).toMatchObject({ ok: true });
    expect(db.table('economy_redemptions')).toHaveLength(1);
  });

  it('refuses a child asking against a sibling’s tokens', async () => {
    const result = await requestRedemptionAction({ rewardId: 'reward-1', memberId: 'member-sibling' });
    expect(result).toMatchObject({ ok: false });
    expect(db.table('economy_redemptions')).toHaveLength(0);
  });

  it('lets a manager ask on a child’s behalf', async () => {
    state.role = 'parent';
    state.memberId = 'member-parent';
    const result = await requestRedemptionAction({ rewardId: 'reward-1', memberId: 'member-sibling' });
    expect(result).toMatchObject({ ok: true });
    expect(db.table('economy_redemptions')[0]).toMatchObject({ member_id: 'member-sibling', status: 'pending' });
  });
});
