import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * When the family's plan could not be read, the allowance actions never
 * answered.
 *
 * `saveAllowanceRuleAction` and `runDueAllowancesAction` gate on the wallet
 * tier, and `resolveFamilyPlanLevel` THROWS when its subscription or family
 * read fails ("Family subscription state is unavailable."). Nothing caught it,
 * so the server action rejected. `components/wallet/allowance-view.tsx` awaits
 * both with a spinner set (`setLoading(true)` / `setRunning(true)`) and clears
 * it only after the await returns, so the Save and "Run now" buttons stayed
 * spinning with no message.
 *
 * The actions now refuse in words, with messages the catalogue already has,
 * and still write and pay nothing: a failed read is not treated as Free or as
 * Basic. The screen's existing `if (!res.ok) return toastError(res.error)`
 * then clears the spinner and shows the message.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, revalidatePath: vi.fn(), failPlan: null as null | 'subscriptions' | 'families' }));

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: { familyId: FAMILY, role: 'parent', member: { id: 'member-self', family_id: FAMILY }, family: { id: FAMILY, timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveAllowanceRuleAction, runDueAllowancesAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const COULD_NOT_SAVE = translate(SOURCE_MESSAGES, 'actions.couldNotSaveThatAllowance');
const COULD_NOT_LOAD_DUE = translate(SOURCE_MESSAGES, 'actions.couldNotLoadDueAllowances');
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.revalidatePath.mockClear();
  harness.failPlan = null;
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('allowance_rules', [
    { id: 'rule-due', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, cadence: 'weekly', split: null, is_active: true, next_run_on: '2026-09-27', last_run_on: '2026-09-20', created_by: 'user-self' },
  ]);
  // The plan read goes through the service client: fail whichever half the test names.
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === harness.failPlan) {
      const failed = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) };
      builder.in = () => failed;
      builder.maybeSingle = async () => ({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' });
    }
    return builder;
  };
});

afterEach(() => { vi.useRealTimers(); });

/** Settle an action either way, so a rejection is visible as a value rather than a thrown test. */
const settle = <T,>(promise: Promise<T>) => promise.then((result) => result, (thrown: unknown) => ({ rejected: thrown instanceof Error ? thrown.message : String(thrown) }));
const rules = () => structuredClone(db.table('allowance_rules'));

describe('an allowance action answers when the plan cannot be read', () => {
  it.each(['subscriptions', 'families'] as const)('saving a rule answers "could not save" when the %s read fails, and writes nothing', async (table) => {
    harness.failPlan = table;
    const before = rules();

    expect(await settle(saveAllowanceRuleAction({ childWalletId: 'wallet-b', amountCents: 800, cadence: 'weekly' })))
      .toEqual({ ok: false, error: COULD_NOT_SAVE });
    expect(await settle(saveAllowanceRuleAction({ id: 'rule-due', childWalletId: 'wallet-a', amountCents: 1_500, cadence: 'weekly' })))
      .toEqual({ ok: false, error: COULD_NOT_SAVE });
    expect(rules()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it.each(['subscriptions', 'families'] as const)('running due allowances answers "could not load" when the %s read fails, and pays nothing', async (table) => {
    harness.failPlan = table;
    const before = rules();

    expect(await settle(runDueAllowancesAction())).toEqual({ ok: false, error: COULD_NOT_LOAD_DUE });
    expect(rules()).toEqual(before);
    expect(db.table('wallet_transactions')).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  describe('with the plan readable, nothing changes', () => {
    it('a Basic family saves a rule', async () => {
      expect(await settle(saveAllowanceRuleAction({ childWalletId: 'wallet-b', amountCents: 800, cadence: 'weekly' }))).toEqual({ ok: true });
      expect(db.table('allowance_rules').find((row) => row.child_wallet_id === 'wallet-b')).toMatchObject({ amount_cents: 800, is_active: true });
    });

    it('a free family is still told allowances are a Basic feature, not that something failed', async () => {
      db.replace('subscriptions', []);
      expect(await settle(saveAllowanceRuleAction({ childWalletId: 'wallet-b', amountCents: 800, cadence: 'weekly' })))
        .toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.automatedAllowancesAreABasic') });
      expect(await settle(runDueAllowancesAction()))
        .toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.automatedAllowancesAreABasic') });
    });
  });
});
