import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * Editing a paused allowance restarted it.
 *
 * `saveAllowanceRuleAction`'s edit branch wrote `is_active: true` along with the
 * new amount, cadence and `next_run_on`. The allowance screen offers the edit
 * (pencil) button on a paused rule as well as an active one and answers
 * "Allowance saved", so a parent who paused a child's allowance and then
 * corrected its amount had quietly turned the payments back on: the nightly
 * cron pays every active rule whose `next_run_on` has come.
 *
 * Pausing and resuming is `toggleAllowanceRuleAction`'s job. An edit now leaves
 * the flag as it finds it; a NEW rule is still created active.
 *
 * The store is in memory and the clock is pinned (2026-09-28T02:30Z, a Basic
 * family on UTC), so the first run dates below are fixed. Row-level security
 * on `allowance_rules` is not exercised here.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', revalidatePath: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: {
      familyId: FAMILY, role: harness.role,
      member: { id: 'member-self', family_id: FAMILY },
      family: { id: FAMILY, timezone: 'UTC' },
    },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveAllowanceRuleAction, toggleAllowanceRuleAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const COULD_NOT_SAVE = translate(SOURCE_MESSAGES, 'actions.couldNotSaveThatAllowance');
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;
let patches: Row[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T02:30:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.revalidatePath.mockClear();
  harness.role = 'parent';
  db = createInMemorySupabase();
  harness.db = db;
  patches = [];
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('allowance_rules', [
    { id: 'rule-paused', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 500, cadence: 'weekly', is_active: false, next_run_on: '2026-08-15', last_run_on: '2026-08-08', created_by: 'user-other' },
    { id: 'rule-active', family_id: FAMILY, child_wallet_id: 'wallet-b', amount_cents: 1_000, cadence: 'weekly', is_active: true, next_run_on: '2026-09-30', last_run_on: '2026-09-23', created_by: 'user-other' },
    { id: 'rule-x', family_id: 'family-2', child_wallet_id: 'wallet-x', amount_cents: 700, cadence: 'weekly', is_active: false, next_run_on: '2026-08-15', last_run_on: null, created_by: 'user-x' },
  ]);
  // Record every patch sent to allowance_rules, and let it through.
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === 'allowance_rules') {
      const update = (builder.update as (patch: Row) => unknown).bind(builder);
      builder.update = (patch: Row) => { patches.push(patch); return update(patch); };
    }
    return builder;
  };
});

afterEach(() => { vi.useRealTimers(); });

const rule = (id: string) => db.table('allowance_rules').find((row) => row.id === id) as Row;
const snapshot = () => structuredClone(db.table('allowance_rules'));

/** Make the next `allowance_rules` update answer `reply` without touching the store. */
function failUpdate(reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === 'allowance_rules') {
      const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, status: 500, statusText: 'Error', ...reply }).then(resolve) };
      builder.update = () => { const chain = { eq: () => chain, select: () => settle }; return chain; };
    }
    return builder;
  };
}

describe('editing an allowance keeps its paused or active state', () => {
  it('a paused allowance that is edited is saved, and stays paused', async () => {
    expect(await saveAllowanceRuleAction({ id: 'rule-paused', childWalletId: 'wallet-a', amountCents: 600, cadence: 'monthly' })).toEqual({ ok: true });

    expect(rule('rule-paused')).toMatchObject({
      amount_cents: 600, cadence: 'monthly', next_run_on: '2026-10-28', is_active: false,
      child_wallet_id: 'wallet-a', last_run_on: '2026-08-08', created_by: 'user-other',
    });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('an active allowance that is edited stays active', async () => {
    expect(await saveAllowanceRuleAction({ id: 'rule-active', childWalletId: 'wallet-b', amountCents: 1_500, cadence: 'weekly' })).toEqual({ ok: true });

    expect(rule('rule-active')).toMatchObject({ amount_cents: 1_500, next_run_on: '2026-10-05', is_active: true });
  });

  it('an edit does not write the active flag at all, so it cannot undo a pause made meanwhile in another tab', async () => {
    await saveAllowanceRuleAction({ id: 'rule-active', childWalletId: 'wallet-b', amountCents: 1_500, cadence: 'weekly' });

    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty('is_active');
  });

  it('a new allowance is still created active', async () => {
    expect(await saveAllowanceRuleAction({ childWalletId: 'wallet-c', amountCents: 800, cadence: 'weekly' })).toEqual({ ok: true });

    const created = db.table('allowance_rules').find((row) => row.child_wallet_id === 'wallet-c');
    expect(created).toMatchObject({ family_id: FAMILY, amount_cents: 800, is_active: true, next_run_on: '2026-10-05', created_by: 'user-self' });
  });

  describe('pausing and resuming is the toggle’s job', () => {
    it('an edited paused allowance resumes when the parent resumes it, on the edited schedule', async () => {
      await saveAllowanceRuleAction({ id: 'rule-paused', childWalletId: 'wallet-a', amountCents: 600, cadence: 'monthly' });

      expect(await toggleAllowanceRuleAction({ id: 'rule-paused', isActive: true })).toEqual({ ok: true });
      expect(rule('rule-paused')).toMatchObject({ is_active: true, amount_cents: 600, next_run_on: '2026-10-28' });
    });

    it('an active allowance paused and then edited stays paused', async () => {
      expect(await toggleAllowanceRuleAction({ id: 'rule-active', isActive: false })).toEqual({ ok: true });
      expect(await saveAllowanceRuleAction({ id: 'rule-active', childWalletId: 'wallet-b', amountCents: 1_200, cadence: 'biweekly' })).toEqual({ ok: true });

      expect(rule('rule-active')).toMatchObject({ is_active: false, amount_cents: 1_200, cadence: 'biweekly' });
    });
  });

  describe('when the edit does not land', () => {
    it('another family’s paused allowance is not edited, and not resumed', async () => {
      const before = snapshot();

      expect(await saveAllowanceRuleAction({ id: 'rule-x', childWalletId: 'wallet-x', amountCents: 9_999, cadence: 'weekly' })).toEqual({ ok: false, error: COULD_NOT_SAVE });
      expect(db.table('allowance_rules')).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed edit leaves the paused allowance exactly as it was', async () => {
      failUpdate({ error: PG_ERROR });
      const before = snapshot();

      expect(await saveAllowanceRuleAction({ id: 'rule-paused', childWalletId: 'wallet-a', amountCents: 600, cadence: 'monthly' }))
        .toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_SAVE) });
      expect(db.table('allowance_rules')).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an edit that matches no row (as RLS would leave it) is not reported as saved', async () => {
      failUpdate({ data: [], error: null, status: 200, statusText: 'OK' });

      expect(await saveAllowanceRuleAction({ id: 'rule-paused', childWalletId: 'wallet-a', amountCents: 600, cadence: 'monthly' })).toEqual({ ok: false, error: COULD_NOT_SAVE });
      expect(rule('rule-paused')).toMatchObject({ is_active: false, amount_cents: 500 });
    });
  });
});
