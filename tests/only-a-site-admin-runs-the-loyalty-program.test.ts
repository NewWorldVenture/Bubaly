// The loyalty console's six server actions (app/(app)/admin/marketing/loyalty/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. Loyalty is run from the site-admin console. Each action opens with
// requireMarketingAdmin (lib/marketing/admin.ts:82-93), which refuses a signed-out
// caller (401), anyone not on the super-admin allowlist (403) and a super admin
// whose session still owes a two-step code (403). A household's own roles grant
// nothing here: a family's parent is not a platform admin (lib/marketing/admin.ts:74-79,
// lib/supabase/auth.ts:75-79). The engine is service-role only (0204's grants,
// supabase/migrations/0204_atomic_loyalty_transactions.sql:283-288).
//
// awardPointsAction and the redemption actions reach households' loyalty
// accounts. That reach is SITE-WIDE by design — a site admin adjusts any
// family's points — so the cross-family question here is that the right
// household's account moves and no other's, and that no household member,
// even of the family being credited, can make the call.
//
// The two RPCs are modelled from 0204 against the real tables: an award
// get-or-creates the family's account, moves balance/lifetime/tier and writes a
// ledger row; a cancel refunds a pending redemption's points to its family,
// marks it cancelled and returns finite stock.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAMILY_A, FAMILY_B, memberIdOf, newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN,
} from './helpers/admin-callers';
import type { InMemorySupabase, Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const actions = await import('@/app/(app)/admin/marketing/loyalty/actions');

const IDS = {
  settings: 'ACTION-BBF7460A6A75',
  saveReward: 'ACTION-1D23B78FE46E',
  deleteReward: 'ACTION-B3FFD0C4C4CE',
  award: 'ACTION-944B9D591C0F',
  fulfill: 'ACTION-E167AEB36458',
  cancel: 'ACTION-17503EE16C2D',
} as const;

const REWARD = 'c0000000-0000-4000-8000-000000000001';
const REDEMPTION_A = 'c1000000-0000-4000-8000-00000000000a';
const REDEMPTION_B = 'c1000000-0000-4000-8000-00000000000b';
const ACCOUNT_A = 'c2000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = 'c2000000-0000-4000-8000-00000000000b';

function tierFor(db: InMemorySupabase, lifetime: number): string {
  const s = db.table('loyalty_settings').find((r) => r.singleton === true);
  const silver = Math.max(0, Number(s?.tier_silver_at ?? 1000));
  const gold = Math.max(silver, Number(s?.tier_gold_at ?? 5000));
  return lifetime >= gold ? 'gold' : lifetime >= silver ? 'silver' : 'bronze';
}

function accountOf(db: InMemorySupabase, familyId: string): Row {
  let account = db.table('loyalty_accounts').find((r) => r.family_id === familyId);
  if (!account) {
    db.seed('loyalty_accounts', [{ family_id: familyId, points_balance: 0, lifetime_points: 0, tier: 'bronze' }]);
    account = db.table('loyalty_accounts').find((r) => r.family_id === familyId) as Row;
  }
  return account;
}

/** 0204's loyalty_award_points and loyalty_cancel_redemption, over the fake's tables. */
const rpc = {
  loyalty_award_points: (a: Record<string, unknown>, db: InMemorySupabase) => {
    if (!a.p_family_id) return { ok: false, reason: 'invalid_family' };
    if (!['earn', 'redeem', 'adjust', 'expire'].includes(String(a.p_kind))) return { ok: false, reason: 'invalid_kind' };
    const account = accountOf(db, String(a.p_family_id));
    const points = Number(a.p_points);
    if (points < 0 && Number(account.points_balance) + points < 0) return { ok: false, reason: 'insufficient_points' };
    account.points_balance = Number(account.points_balance) + points;
    account.lifetime_points = Number(account.lifetime_points) + Math.max(0, points);
    account.tier = tierFor(db, Number(account.lifetime_points));
    const id = `c3000000-0000-4000-8000-${String(db.table('loyalty_transactions').length + 1).padStart(12, '0')}`;
    db.seed('loyalty_transactions', [{
      id, family_id: a.p_family_id, points, kind: a.p_kind, reason: a.p_reason, source: a.p_source,
      balance_after: account.points_balance, reward_id: a.p_reward_id, created_by: a.p_actor_id, metadata: {},
    }]);
    return { ok: true, transaction_id: id, account: { ...account } };
  },
  loyalty_cancel_redemption: (a: Record<string, unknown>, db: InMemorySupabase) => {
    const redemption = db.table('loyalty_redemptions').find((r) => r.id === a.p_redemption_id);
    if (!redemption) return { ok: false, reason: 'not_found' };
    if (redemption.status !== 'pending') return { ok: false, reason: 'already_processed' };
    const reward = db.table('loyalty_rewards').find((r) => r.id === redemption.reward_id);
    const account = accountOf(db, String(redemption.family_id));
    const refund = Math.max(0, Number(redemption.cost_points));
    account.points_balance = Number(account.points_balance) + refund;
    if (refund > 0) {
      db.seed('loyalty_transactions', [{
        family_id: redemption.family_id, points: refund, kind: 'adjust', reason: 'Redemption cancelled - points refunded',
        source: 'redemption_refund', balance_after: account.points_balance, reward_id: redemption.reward_id, created_by: a.p_actor_id,
      }]);
    }
    redemption.status = 'cancelled';
    if (reward && reward.stock !== null && reward.stock !== undefined) reward.stock = Number(reward.stock) + 1;
    return { ok: true, points_refunded: refund };
  },
};

let db: InMemorySupabase;

const fd = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld({ rpc });
  db.seed('loyalty_settings', [{ singleton: true, enabled: false, program_name: 'Bubaly Rewards', points_label: 'points', tier_silver_at: 1000, tier_gold_at: 5000 }]);
  db.seed('loyalty_rewards', [{ id: REWARD, name: 'Gift card', cost_points: 200, kind: 'credit', stock: 4, is_active: true, deleted_at: null, sort: 0 }]);
  db.seed('loyalty_accounts', [
    { id: ACCOUNT_A, family_id: FAMILY_A, points_balance: 300, lifetime_points: 900, tier: 'bronze' },
    { id: ACCOUNT_B, family_id: FAMILY_B, points_balance: 300, lifetime_points: 900, tier: 'bronze' },
  ]);
  db.seed('loyalty_redemptions', [
    { id: REDEMPTION_A, family_id: FAMILY_A, reward_id: REWARD, reward_name: 'Gift card', cost_points: 200, status: 'pending', created_by: memberIdOf('parent', 'A') },
    { id: REDEMPTION_B, family_id: FAMILY_B, reward_id: REWARD, reward_name: 'Gift card', cost_points: 200, status: 'pending', created_by: memberIdOf('parent', 'B') },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const audit = () => db.table('marketing_audit_logs').map((r) => [r.action, r.resource, r.resource_id ?? null, r.actor_id]);
const account = (id: string) => db.table('loyalty_accounts').find((r) => r.id === id);

/** Each action, called with valid input, for the refusal matrix. */
const CALLS: [string, () => Promise<unknown>][] = [
  [IDS.settings, () => actions.saveLoyaltySettingsAction(fd({ enabled: 'on', program_name: 'Family Stars', earn_signup: '50' }))],
  [IDS.saveReward, () => actions.saveRewardAction(fd({ name: 'Movie night', cost_points: '100', kind: 'credit', is_active: 'on' }))],
  [IDS.deleteReward, () => actions.deleteRewardAction(REWARD)],
  [IDS.award, () => actions.awardPointsAction(fd({ family_id: FAMILY_A, points: '500', reason: 'Goodwill', request_id: 'req-1' }))],
  [IDS.fulfill, () => actions.fulfillRedemptionAction(fd({ id: REDEMPTION_A, code: 'GIFT-CODE-1' }))],
  [IDS.cancel, () => actions.cancelRedemptionAction(REDEMPTION_A)],
];

describe('every loyalty action refuses anyone but a site admin, and writes nothing', () => {
  const matrix = CALLS.flatMap(([id, call]) => REFUSED_CALLERS.map((c) => ({ id, call, ...c })));
  it.each(matrix)('$id $label is refused and nothing is written', async ({ call, caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(call()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('a site admin', () => {
  beforeEach(() => signInAs({ kind: 'super_admin' }));

  it(`${IDS.settings} saves the program settings over the one singleton row`, async () => {
    await actions.saveLoyaltySettingsAction(fd({ enabled: 'on', program_name: 'Family Stars', earn_signup: '50', tier_gold_at: '4000' }));
    expect(db.table('loyalty_settings')).toEqual([expect.objectContaining({
      singleton: true, enabled: true, program_name: 'Family Stars', points_label: 'points',
      earn_signup: 50, earn_referral: 0, tier_silver_at: 1000, tier_gold_at: 4000, updated_by: SUPER_ADMIN.id,
    })]);
    expect(audit()).toEqual([['update', 'loyalty_settings', null, SUPER_ADMIN.id]]);
  });

  it(`${IDS.saveReward} creates a reward, then edits that one reward`, async () => {
    await actions.saveRewardAction(fd({ name: 'Movie night', cost_points: '100', kind: 'credit', is_active: 'on', stock: '3' }));
    const created = db.table('loyalty_rewards').find((r) => r.name === 'Movie night');
    expect(created).toMatchObject({ cost_points: 100, kind: 'credit', is_active: true, stock: 3, created_by: SUPER_ADMIN.id });
    await actions.saveRewardAction(fd({ id: REWARD, name: 'Bigger gift card', cost_points: '250' }));
    expect(db.table('loyalty_rewards').find((r) => r.id === REWARD)).toMatchObject({ name: 'Bigger gift card', cost_points: 250, is_active: false });
    expect(db.table('loyalty_rewards')).toHaveLength(2);
    expect(audit()).toEqual([
      ['create', 'loyalty_reward', created?.id, SUPER_ADMIN.id],
      ['update', 'loyalty_reward', REWARD, SUPER_ADMIN.id],
    ]);
  });

  it(`${IDS.deleteReward} soft-deletes and deactivates the reward`, async () => {
    await actions.deleteRewardAction(REWARD);
    expect(db.table('loyalty_rewards')[0]).toMatchObject({ id: REWARD, is_active: false, deleted_at: expect.any(String) });
    expect(audit()).toEqual([['delete', 'loyalty_reward', REWARD, SUPER_ADMIN.id]]);
  });

  it(`${IDS.award} adjusts household A's account only, once per form submission`, async () => {
    const b = structuredClone(account(ACCOUNT_B));
    await actions.awardPointsAction(fd({ family_id: FAMILY_A, points: '500', reason: 'Goodwill', request_id: 'req-1' }));
    await actions.awardPointsAction(fd({ family_id: FAMILY_A, points: '500', reason: 'Goodwill', request_id: 'req-1' }));
    expect(account(ACCOUNT_A)).toMatchObject({ points_balance: 800, lifetime_points: 1400, tier: 'silver' });
    expect(account(ACCOUNT_B)).toEqual(b);
    expect(db.table('loyalty_transactions')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, points: 500, kind: 'adjust', source: 'manual', reason: 'Goodwill',
      balance_after: 800, created_by: SUPER_ADMIN.id, metadata: { request_id: 'req-1' },
    })]);
    expect(audit()).toEqual([['award', 'loyalty_account', FAMILY_A, SUPER_ADMIN.id]]);
  });

  it(`${IDS.award} reaches household B (site-wide) and leaves household A untouched`, async () => {
    const a = structuredClone(account(ACCOUNT_A));
    await actions.awardPointsAction(fd({ family_id: FAMILY_B, points: '-100', reason: 'Correction' }));
    expect(account(ACCOUNT_B)).toMatchObject({ points_balance: 200, lifetime_points: 900 });
    expect(account(ACCOUNT_A)).toEqual(a);
    expect(db.table('loyalty_transactions').map((r) => r.family_id)).toEqual([FAMILY_B]);
  });

  it(`${IDS.fulfill} fulfills the named pending redemption and no other`, async () => {
    await actions.fulfillRedemptionAction(fd({ id: REDEMPTION_A, code: 'GIFT-CODE-1', notes: 'Emailed' }));
    expect(db.table('loyalty_redemptions').find((r) => r.id === REDEMPTION_A)).toMatchObject({
      status: 'fulfilled', code: 'GIFT-CODE-1', notes: 'Emailed', fulfilled_by: SUPER_ADMIN.id, fulfilled_at: expect.any(String),
    });
    expect(db.table('loyalty_redemptions').find((r) => r.id === REDEMPTION_B)).toMatchObject({ status: 'pending' });
    expect(audit()).toEqual([['fulfill', 'loyalty_redemption', REDEMPTION_A, SUPER_ADMIN.id]]);
    const before = snapshot(db);
    await expect(actions.fulfillRedemptionAction(fd({ id: REDEMPTION_A, code: 'AGAIN' }))).rejects.toThrow();
    expect(snapshot(db)).toEqual(before);
  });

  it(`${IDS.cancel} refunds the redemption's own household and returns the stock`, async () => {
    const a = structuredClone(account(ACCOUNT_A));
    await actions.cancelRedemptionAction(REDEMPTION_B);
    expect(db.table('loyalty_redemptions').map((r) => [r.id, r.status])).toEqual([[REDEMPTION_A, 'pending'], [REDEMPTION_B, 'cancelled']]);
    expect(account(ACCOUNT_B)).toMatchObject({ points_balance: 500 });
    expect(account(ACCOUNT_A)).toEqual(a);
    expect(db.table('loyalty_rewards')[0]).toMatchObject({ stock: 5 });
    expect(audit()).toEqual([['cancel', 'loyalty_redemption', REDEMPTION_B, SUPER_ADMIN.id]]);
  });
});
