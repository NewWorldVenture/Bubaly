// M9 and M10 — a guest is kept out of the family wallet behind its pages too.
//
// Every /wallet page sends a guest away (refuseGuest, the held 0509). Two
// doors behind those pages did not:
//
//   M9   POST /api/ai/wallet, /api/ai/wallet/child/[childId] and /api/ai/invest
//        checked only the session, the tier and the rate limit, so a guest got
//        model coaching built from the children's balances, Save buckets and
//        goals (or a child's portfolio), on the family's metered coach quota.
//   M10  Activating the wallet gave every non-manager a CHILD wallet, caregivers
//        and guests included. A guest then owned a wallet, and the actions that
//        accept "my own wallet" (an allowance request, a spend request, an
//        invest order) filed into the parents' queue for them.
//
// The routes and actions are driven for real against an in-memory database;
// the model is the seam, and whether it is asked is the question.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'guest' as string,
  memberId: 'member-guest',
  complete: vi.fn(async () => ({ text: '{"headline":"Keep going","insights":[]}', model: 'test', usage: {} })),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.role}` },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: harness.memberId }, family: { id: 'family-1', name: 'Rivera', timezone: 'UTC' } },
  }),
  effectivePlanLevel: async () => 3,
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  };
});
vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => 3,
  // The same, unlocked family as the whole entitlement the AI allowance (F19) reads.
  resolveFamilyEntitlement: async () => ({ effectiveLevel: 3, locked: false, closed: false, inTrial: false, trialEndsAt: null }),
}));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: harness.complete }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: unknown) => unknown) => run({ used() {}, failed() {} }),
}));
// The Trust Engine's own rules are not the question; it answers "allow".
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: async () => ({ decision: { effect: 'allow', basis: 'grant' } }),
  roleOf: (role: string) => role,
}));

const { POST: coach } = await import('@/app/api/ai/wallet/route');
const { POST: childCoach } = await import('@/app/api/ai/wallet/child/[childId]/route');
const { POST: mentor } = await import('@/app/api/ai/invest/route');
const { activateFamilyWalletAction, requestAllowanceAction, requestSpendAction } = await import('@/app/(app)/wallet/actions');
const { placeInvestOrderAction } = await import('@/app/(app)/wallet/invest/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

let db: InMemorySupabase;

function as(role: string, memberId: string) {
  harness.role = role;
  harness.memberId = memberId;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.complete.mockClear();
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Pat', role: 'parent', is_active: true },
    { id: 'member-kid', family_id: FAMILY, user_id: null, display_name: 'Ava', role: 'child', is_active: true },
    { id: 'member-teen', family_id: FAMILY, user_id: null, display_name: 'Tom', role: 'teen', is_active: true },
    { id: 'member-sitter', family_id: FAMILY, user_id: 'user-caregiver', display_name: 'Sam', role: 'caregiver', is_active: true },
    { id: 'member-guest', family_id: FAMILY, user_id: 'user-guest', display_name: 'Gran', role: 'guest', is_active: true },
  ]);
});

describe('M9 — the AI money coach and mentor refuse a guest', () => {
  beforeEach(() => {
    db.seed('child_wallets', [{ id: 'wallet-ava', family_id: FAMILY, member_id: 'member-kid', is_active: true }]);
    db.seed('wallet_buckets', [{ id: 'bucket-save', family_id: FAMILY, child_wallet_id: 'wallet-ava', kind: 'save' }]);
    db.seed('wallet_transactions', [{ id: 'txn-1', family_id: FAMILY, child_wallet_id: 'wallet-ava', bucket_id: 'bucket-save', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5000, created_at: new Date().toISOString() }]);
  });

  it('a parent is coached (the control)', async () => {
    as('parent', 'member-parent');
    const res = await coach();
    expect(res.status).toBe(200);
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the family coach', () => coach()],
    ['a child\'s coach', () => childCoach(new Request('https://fixture.invalid'), { params: Promise.resolve({ childId: 'wallet-ava' }) })],
    ['the money mentor', () => mentor(new Request('https://fixture.invalid/api/ai/invest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ childWalletId: 'wallet-ava', concept: 'compounding' }),
    }) as never)],
  ])('%s answers a guest 403, and the model is not asked', async (_name, call) => {
    as('guest', 'member-guest');
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: t('householdMoney.keptByParents') });
    expect(harness.complete).not.toHaveBeenCalled();
    // Nor is the family's daily coach quota spent on it.
    expect(db.table('wallet_audit_logs')).toHaveLength(0);
  });
});

describe('M10 — wallet activation provisions the children, and a guest files nothing', () => {
  it('activating gives a wallet to the child and the teen, not to the caregiver or the guest', async () => {
    as('parent', 'member-parent');
    expect(await activateFamilyWalletAction()).toEqual({ ok: true });
    const owners = db.table('child_wallets').map((w) => w.member_id).sort();
    expect(owners).toEqual(['member-kid', 'member-teen']);
  });

  describe('a guest who holds a wallet from before', () => {
    beforeEach(() => {
      as('guest', 'member-guest');
      db.seed('child_wallets', [{ id: 'wallet-guest', family_id: FAMILY, member_id: 'member-guest', is_active: true }]);
      db.seed('wallet_buckets', [
        { id: 'guest-spend', family_id: FAMILY, child_wallet_id: 'wallet-guest', kind: 'spend' },
        { id: 'guest-invest', family_id: FAMILY, child_wallet_id: 'wallet-guest', kind: 'invest' },
      ]);
      db.seed('wallet_transactions', [
        { id: 'fund-spend', family_id: FAMILY, child_wallet_id: 'wallet-guest', bucket_id: 'guest-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 10_000 },
        { id: 'fund-invest', family_id: FAMILY, child_wallet_id: 'wallet-guest', bucket_id: 'guest-invest', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 10_000 },
      ]);
      db.seed('wallet_rules', [{ id: 'rule-guest', family_id: FAMILY, child_wallet_id: 'wallet-guest', require_approval_over_cents: 5000 }]);
      db.seed('invest_assets', [{ id: 'asset-1', symbol: 'FUND', price_cents: 1000, is_active: true }]);
    });

    it('cannot file an allowance request into the parents\' queue', async () => {
      const res = await requestAllowanceAction({ childWalletId: 'wallet-guest', amountCents: 500, reason: 'please' });
      expect(res).toEqual({ ok: false, error: t('actions.notAuthorized') });
      expect(db.table('parent_approvals')).toHaveLength(0);
    });

    it('cannot ask to spend', async () => {
      const res = await requestSpendAction({ childWalletId: 'wallet-guest', amountCents: 500, description: 'Treat' });
      expect(res).toEqual({ ok: false, error: t('actions.notAuthorized') });
      expect(db.table('parent_approvals')).toHaveLength(0);
      expect(db.table('wallet_transactions').filter((r) => r.direction === 'debit')).toHaveLength(0);
    });

    it('cannot queue an invest order', async () => {
      const res = await placeInvestOrderAction({ childWalletId: 'wallet-guest', assetId: 'asset-1', side: 'buy', shares: 1 });
      expect(res).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
      expect(db.table('invest_orders')).toHaveLength(0);
    });
  });

  it('a child still asks for their own allowance (the control)', async () => {
    as('child', 'member-kid');
    db.seed('child_wallets', [{ id: 'wallet-ava', family_id: FAMILY, member_id: 'member-kid', is_active: true }]);
    expect(await requestAllowanceAction({ childWalletId: 'wallet-ava', amountCents: 500 })).toEqual({ ok: true });
    expect(db.table('parent_approvals')).toHaveLength(1);
  });
});
