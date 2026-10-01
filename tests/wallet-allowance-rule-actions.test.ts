import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * saveAllowanceRuleAction and toggleAllowanceRuleAction
 * (app/(app)/wallet/actions.ts), run as code. Nothing ran either action; the
 * allowance tests that exist drive the cron and the manual run. This drives both
 * against the in-memory store, with the real plan resolution
 * (`resolveFamilyPlanLevel` → `computeEntitlement` → wallet tier), the real
 * schedule arithmetic (`dayKeyInTz`, `nextRunDate`) and the real message
 * catalogue, and asserts what each one reads, writes and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-2E83328F1CA0 (saveAllowanceRuleAction), ACTION-432EA8AE6D79
 * (toggleAllowanceRuleAction).
 *
 * The clock is pinned to 2026-09-28T02:30Z: Monday in UTC, still Sunday
 * evening in Los Angeles. Row-level security on `allowance_rules` (0306) and
 * 0311's same-family reference guard are not exercised here.
 */

const FAMILY = 'family-1';
const NOW = '2026-09-28T02:30:00.000Z';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  timezone: 'UTC' as string | null,
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: {
      familyId: FAMILY, role: harness.role,
      member: { id: 'member-self', family_id: FAMILY },
      family: { id: FAMILY, timezone: harness.timezone },
    },
  }),
  // The real one lifts a super-admin to Plus; nobody here is one.
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
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "allowance_rules"', details: null, hint: null };
const SPLIT = { spend: 50, save: 50, give: 0, invest: 0 };

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.timezone = 'UTC';
  harness.revalidatePath.mockClear();
  db.seed('families', [
    { id: FAMILY, trial_ends_at: null, closed_at: null },
    { id: 'family-2', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('allowance_rules', [
    { id: 'rule-1', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, cadence: 'weekly', split: SPLIT, is_active: true, next_run_on: '2026-09-30', last_run_on: '2026-09-23', created_by: 'user-other' },
    { id: 'rule-paused', family_id: FAMILY, child_wallet_id: 'wallet-b', amount_cents: 500, cadence: 'monthly', split: null, is_active: false, next_run_on: '2026-08-15', last_run_on: '2026-07-15', created_by: 'user-other' },
    { id: 'rule-x', family_id: 'family-2', child_wallet_id: 'wallet-x', amount_cents: 2_000, cadence: 'weekly', split: null, is_active: true, next_run_on: '2026-10-01', last_run_on: null, created_by: 'user-x' },
  ]);
});

afterEach(() => { vi.useRealTimers(); });

/** Replace `allowance_rules` writes so they answer `reply` instead of touching the store. */
function override(method: 'insert' | 'update', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== 'allowance_rules') return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) };
    if (method === 'insert') builder.insert = () => ({ select: () => settle });
    if (method === 'update') builder.update = () => { const chain = { eq: () => chain, select: () => settle }; return chain; };
    return builder;
  };
}

const rules = () => db.table('allowance_rules');
const rule = (id: string) => rules().find((row) => row.id === id) as Row;
const snapshot = () => structuredClone(rules());
const others = (rows: Row[], id: string) => rows.filter((row) => row.id !== id);
const created = () => rules().filter((row) => !['rule-1', 'rule-paused', 'rule-x'].includes(String(row.id)));
const touched = () => db.log.map((entry) => entry.table);
const save = (over: Partial<Parameters<typeof saveAllowanceRuleAction>[0]> = {}) =>
  saveAllowanceRuleAction({ childWalletId: 'wallet-c', amountCents: 1_000, cadence: 'weekly', ...over });

describe('saveAllowanceRuleAction (ACTION-2E83328F1CA0)', () => {
  describe('a new rule', () => {
    it('adds one active rule for that wallet, scheduled a cadence from today, credited to the user', async () => {
      const before = snapshot();

      expect(await save()).toEqual({ ok: true });

      expect(created()).toHaveLength(1);
      expect(created()[0]).toMatchObject({
        family_id: FAMILY, child_wallet_id: 'wallet-c', amount_cents: 1_000, cadence: 'weekly',
        is_active: true, next_run_on: '2026-10-05', created_by: 'user-self',
      });
      expect(rules().filter((row) => row !== created()[0])).toEqual(before);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    });

    it('an adult may set one too', async () => {
      harness.role = 'adult';
      expect(await save()).toEqual({ ok: true });
      expect(created()).toHaveLength(1);
    });

    it.each([
      ['weekly', '2026-10-05'],
      ['biweekly', '2026-10-12'],
      ['monthly', '2026-10-28'],
    ] as const)('a %s rule is first due %s', async (cadence, due) => {
      expect(await save({ cadence })).toEqual({ ok: true });
      expect(created()[0]).toMatchObject({ cadence, next_run_on: due });
    });

    it('counts from the family’s own calendar day, not the server’s', async () => {
      harness.timezone = 'America/Los_Angeles';
      expect(await save()).toEqual({ ok: true });
      // Still Sunday the 27th in Los Angeles.
      expect(created()[0].next_run_on).toBe('2026-10-04');
    });

    it('a family with no timezone set is scheduled on UTC', async () => {
      harness.timezone = null;
      expect(await save()).toEqual({ ok: true });
      expect(created()[0].next_run_on).toBe('2026-10-05');
    });

    it('whole cents only', async () => {
      expect(await save({ amountCents: 1_234.9 })).toEqual({ ok: true });
      expect(created()[0].amount_cents).toBe(1_234);
    });

    it('a refused insert is a failure in words, and refreshes nothing', async () => {
      override('insert', { error: RLS_DENIED });

      expect(await save()).toEqual({ ok: false, error: describeActionError(RLS_DENIED, t('actions.couldNotSaveThatAllowance')) });
      expect(created()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('an existing rule', () => {
    it('takes the new amount, cadence and schedule, and keeps its wallet, author, split and last run', async () => {
      const before = snapshot();

      expect(await save({ id: 'rule-1', childWalletId: 'wallet-a', amountCents: 1_500, cadence: 'monthly' })).toEqual({ ok: true });

      expect(rule('rule-1')).toMatchObject({
        id: 'rule-1', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_500, cadence: 'monthly',
        next_run_on: '2026-10-28', is_active: true, split: SPLIT, last_run_on: '2026-09-23', created_by: 'user-other',
      });
      expect(others(rules(), 'rule-1')).toEqual(others(before, 'rule-1'));
      expect(created()).toHaveLength(0);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    });

    it('cannot be moved to another child’s wallet by an edit', async () => {
      expect(await save({ id: 'rule-1', childWalletId: 'wallet-b', amountCents: 1_500 })).toEqual({ ok: true });
      expect(rule('rule-1').child_wallet_id).toBe('wallet-a');
    });

    it.each([
      ['another family’s rule', 'rule-x'],
      ['a rule that does not exist', 'rule-missing'],
    ])('%s is not changed, and the action says so', async (_label, id) => {
      const before = snapshot();

      expect(await save({ id, amountCents: 9_999 })).toEqual({ ok: false, error: t('actions.couldNotSaveThatAllowance') });
      expect(rules()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an edit that matches no row (as RLS would leave it) is not reported as saved', async () => {
      override('update', { data: [], error: null, status: 200, statusText: 'OK' });

      expect(await save({ id: 'rule-1', amountCents: 1_500 })).toEqual({ ok: false, error: t('actions.couldNotSaveThatAllowance') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed edit is a failure in words, and the old rule stands', async () => {
      override('update', { error: PG_ERROR });

      expect(await save({ id: 'rule-1', amountCents: 1_500 })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotSaveThatAllowance')) });
      expect(rule('rule-1').amount_cents).toBe(1_000);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('the plan gate: allowances are a Basic feature', () => {
    it.each([
      ['Plus', [{ family_id: FAMILY, plan: 'plus', status: 'active' }], {}],
      ['a Basic trial subscription', [{ family_id: FAMILY, plan: 'basic_annual', status: 'trialing' }], {}],
      ['the free trial, still running', [], { trial_ends_at: '2026-10-01T00:00:00.000Z' }],
    ])('allowed on %s', async (_label, subs, family) => {
      db.replace('subscriptions', subs);
      Object.assign(db.table('families')[0], family);

      expect(await save()).toEqual({ ok: true });
      expect(created()).toHaveLength(1);
    });

    it.each([
      ['a free family', [], {}],
      ['a free trial that has ended', [], { trial_ends_at: '2026-09-27T00:00:00.000Z' }],
      ['a cancelled Basic subscription', [{ family_id: FAMILY, plan: 'basic', status: 'canceled' }], {}],
      ['another family’s Basic subscription', [{ family_id: 'family-2', plan: 'basic', status: 'active' }], {}],
      ['a closed family, even with Basic', [{ family_id: FAMILY, plan: 'basic', status: 'active' }], { closed_at: '2026-09-01T00:00:00.000Z' }],
    ])('refused for %s, before the amount or any rule is looked at', async (_label, subs, family) => {
      db.replace('subscriptions', subs);
      Object.assign(db.table('families')[0], family);
      const before = snapshot();

      expect(await save({ amountCents: 0 })).toEqual({ ok: false, error: t('actions.automatedAllowancesAreABasic') });
      expect(touched()).not.toContain('allowance_rules');
      expect(rules()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an edit is gated the same way', async () => {
      db.replace('subscriptions', []);
      expect(await save({ id: 'rule-1', amountCents: 1_500 })).toEqual({ ok: false, error: t('actions.automatedAllowancesAreABasic') });
      expect(rule('rule-1').amount_cents).toBe(1_000);
    });

    it('when the plan cannot be read, nothing is saved and success is not claimed', async () => {
      const from = db.from.bind(db);
      (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
        const builder = from(name) as unknown as Record<string, unknown>;
        if (name === 'subscriptions') {
          builder.in = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) });
        }
        return builder;
      };
      const before = snapshot();

      const outcome = await save().then((result) => result, (thrown: unknown) => ({ thrown }));

      expect(outcome).not.toEqual({ ok: true });
      expect(rules()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses', () => {
    it.each(NON_MANAGERS)('a %s, before reading anything', async (role) => {
      harness.role = role;
      const before = snapshot();

      expect(await save()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan4') });
      expect(await save({ id: 'rule-1' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan4') });
      expect(db.log).toHaveLength(0);
      expect(rules()).toEqual(before);
    });

    it.each([0, -500, 0.9, Number.NaN, Number.POSITIVE_INFINITY])('an amount of %s, before any rule is touched', async (amountCents) => {
      const before = snapshot();

      expect(await save({ amountCents })).toEqual({ ok: false, error: t('actions.enterAnAllowanceGreaterThan') });
      expect(await save({ id: 'rule-1', amountCents })).toEqual({ ok: false, error: t('actions.enterAnAllowanceGreaterThan') });
      expect(touched()).not.toContain('allowance_rules');
      expect(rules()).toEqual(before);
    });
  });
});

describe('toggleAllowanceRuleAction (ACTION-432EA8AE6D79)', () => {
  it('pausing turns off only that rule’s active flag, and refreshes the allowance page', async () => {
    const before = snapshot();

    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: true });

    expect(rule('rule-1')).toEqual({ ...before.find((row) => row.id === 'rule-1'), is_active: false });
    expect(others(rules(), 'rule-1')).toEqual(others(before, 'rule-1'));
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/allowance');
  });

  it('resuming turns it back on and leaves its schedule as it was', async () => {
    const before = snapshot();

    expect(await toggleAllowanceRuleAction({ id: 'rule-paused', isActive: true })).toEqual({ ok: true });

    expect(rule('rule-paused')).toEqual({ ...before.find((row) => row.id === 'rule-paused'), is_active: true });
    expect(others(rules(), 'rule-paused')).toEqual(others(before, 'rule-paused'));
  });

  it('an adult may pause one too', async () => {
    harness.role = 'adult';
    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: true });
    expect(rule('rule-1').is_active).toBe(false);
  });

  it('touches only the rule itself: no plan read, so a family that lost Basic can still pause', async () => {
    db.replace('subscriptions', []);

    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: true });
    expect(touched()).toEqual(['allowance_rules']);
  });

  it.each(NON_MANAGERS)('refuses a %s before touching the database', async (role) => {
    harness.role = role;
    const before = snapshot();

    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan5') });
    expect(db.log).toHaveLength(0);
    expect(rules()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['another family’s rule', 'rule-x'],
    ['a rule that does not exist', 'rule-missing'],
  ])('%s is not changed, and the action says so', async (_label, id) => {
    const before = snapshot();

    expect(await toggleAllowanceRuleAction({ id, isActive: false })).toEqual({ ok: false, error: t('actions.couldNotUpdateThatAllowance') });
    expect(rules()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a pause that matches no row (as RLS would leave it) is not reported as paused', async () => {
    override('update', { data: [], error: null, status: 200, statusText: 'OK' });

    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: false, error: t('actions.couldNotUpdateThatAllowance') });
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a failed pause is a failure in words, and the rule keeps paying', async () => {
    override('update', { error: PG_ERROR });

    expect(await toggleAllowanceRuleAction({ id: 'rule-1', isActive: false })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotUpdateThatAllowance')) });
    expect(rule('rule-1').is_active).toBe(true);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
