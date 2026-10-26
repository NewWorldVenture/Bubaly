// DATA-001 — two FIRST allowance saves for one child, at once, leave one rule.
//
// saveAllowanceRuleAction refuses a new rule for a child who already has one
// (tests/a-child-has-one-allowance-and-every-rule-is-shown.test.ts), but the
// refusal is a read before the insert. A double-submitted "Set allowance" form,
// two tabs, or two parents setting the same child's first allowance together
// all read "no rule yet", and both inserted: allowance_rules has no unique key
// per wallet. The nightly cron and "Run due now" pay every active due rule, so
// the child was paid twice every period from then on.
//
// The real action is driven twice, overlapping, against the in-memory
// database. Whatever the interleaving, the child ends with ONE rule, one save
// is told the child already has an allowance, and the rule that stays is the
// one the other save reported as saved.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-parent' }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveAllowanceRuleAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const AVA_WALLET = 'wallet-ava';
let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // `created_at` is what the database stamps on insert (0088: default now()).
  // One value for both rows: the tie is the hard case, broken by id.
  db = createInMemorySupabase({ defaults: { allowance_rules: { created_at: '2026-10-22T10:00:00.000Z' } } });
  harness.db = db;
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('family_members', [{ id: 'member-ava', family_id: FAMILY, display_name: 'Ava', role: 'child', is_active: true }]);
  db.seed('child_wallets', [{ id: AVA_WALLET, family_id: FAMILY, member_id: 'member-ava', is_active: true }]);
});

const rules = () => db.table('allowance_rules').filter((r) => r.child_wallet_id === AVA_WALLET);

describe('two first allowance saves for one child, at once', () => {
  it('leave the child one rule, so the cron pays the allowance once a period', async () => {
    const results = await Promise.all([
      saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' }),
      saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' }),
    ]);

    expect(rules()).toHaveLength(1);
    expect(rules().filter((r) => r.is_active === true)).toHaveLength(1);
    // One save stands; the other is told what is true — the child has one.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: t('actions.thisChildAlreadyHasAnAllowance') }]);
  });

  it('keep the amount of the save that was told it saved', async () => {
    const [first, second] = await Promise.all([
      saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' }),
      saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1500, cadence: 'weekly' }),
    ]);

    expect(rules()).toHaveLength(1);
    const saved = first.ok ? 1000 : second.ok ? 1500 : null;
    expect(saved).not.toBeNull();
    expect(rules()[0].amount_cents).toBe(saved);
  });

  it('a single first save is unchanged: one rule, saved', async () => {
    const res = await saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' });
    expect(res).toEqual({ ok: true });
    expect(rules()).toHaveLength(1);
  });
});
