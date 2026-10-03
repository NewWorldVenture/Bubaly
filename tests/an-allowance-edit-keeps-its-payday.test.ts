import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * Changing an allowance's amount moved the child's payday.
 *
 * `saveAllowanceRuleAction`'s edit branch always wrote
 * `next_run_on = nextRunDate(today, cadence)`. A weekly allowance last paid
 * 09-22 and due tomorrow (09-29), raised from $10 to $12 today, was next paid on
 * 10-05: 13 days between payments instead of 7, one payment fewer. A monthly one
 * last paid 09-01 and due 10-01, edited on 09-28, went to 10-28: 57 days instead
 * of 30. The allowance row shows "next <date>" and the dialog never said the
 * date would move.
 *
 * An edit that keeps the cadence of an ACTIVE allowance now keeps the payday. A
 * cadence change still re-dates from today (a weekly date means nothing to a
 * monthly rule), and so does a rule that has no date yet, and so does a paused
 * one: its date stopped meaning anything when it was paused, and keeping a date
 * from before the pause would make resuming it pay at once.
 *
 * The store is in memory and the clock is pinned (2026-09-28T02:30Z, a Basic
 * family on UTC). Row-level security on `allowance_rules` is not exercised.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, revalidatePath: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: {
      familyId: FAMILY, role: 'parent',
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
const { rollForward } = await import('@/lib/wallet/allowance');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const COULD_NOT_SAVE = translate(SOURCE_MESSAGES, 'actions.couldNotSaveThatAllowance');
const { describeActionError } = await import('@/lib/supabase/errors');
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;
let patches: Row[];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T02:30:00.000Z'));
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.revalidatePath.mockClear();
  db = createInMemorySupabase();
  harness.db = db;
  patches = [];
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('allowance_rules', [
    { id: 'weekly-tomorrow', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, cadence: 'weekly', is_active: true, next_run_on: '2026-09-29', last_run_on: '2026-09-22', created_by: 'user-other' },
    { id: 'monthly-soon', family_id: FAMILY, child_wallet_id: 'wallet-b', amount_cents: 2_000, cadence: 'monthly', is_active: true, next_run_on: '2026-10-01', last_run_on: '2026-09-01', created_by: 'user-other' },
    { id: 'weekly-overdue', family_id: FAMILY, child_wallet_id: 'wallet-c', amount_cents: 500, cadence: 'weekly', is_active: true, next_run_on: '2026-09-27', last_run_on: '2026-09-20', created_by: 'user-other' },
    { id: 'biweekly-paused', family_id: FAMILY, child_wallet_id: 'wallet-d', amount_cents: 700, cadence: 'biweekly', is_active: false, next_run_on: '2026-08-15', last_run_on: '2026-08-01', created_by: 'user-other' },
    { id: 'weekly-undated', family_id: FAMILY, child_wallet_id: 'wallet-e', amount_cents: 300, cadence: 'weekly', is_active: true, next_run_on: null, last_run_on: null, created_by: 'user-other' },
    { id: 'other-family', family_id: 'family-2', child_wallet_id: 'wallet-x', amount_cents: 900, cadence: 'weekly', is_active: true, next_run_on: '2026-09-29', last_run_on: null, created_by: 'user-x' },
  ]);
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

afterEach(() => { vi.useRealTimers(); consoleError.mockRestore(); });

const rule = (id: string) => db.table('allowance_rules').find((row) => row.id === id) as Row;
const snapshot = () => structuredClone(db.table('allowance_rules'));
const edit = (id: string, amountCents: number, cadence: 'weekly' | 'biweekly' | 'monthly') =>
  saveAllowanceRuleAction({ id, childWalletId: String(rule(id)?.child_wallet_id ?? 'wallet-x'), amountCents, cadence });

describe('changing only the amount keeps the payday', () => {
  it('a weekly allowance due tomorrow is still paid tomorrow, at the new amount', async () => {
    expect(await edit('weekly-tomorrow', 1_200, 'weekly')).toEqual({ ok: true });

    expect(rule('weekly-tomorrow')).toMatchObject({
      amount_cents: 1_200, cadence: 'weekly', next_run_on: '2026-09-29', is_active: true, last_run_on: '2026-09-22',
    });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('a monthly allowance keeps its day of the month', async () => {
    expect(await edit('monthly-soon', 2_500, 'monthly')).toEqual({ ok: true });

    expect(rule('monthly-soon')).toMatchObject({ amount_cents: 2_500, next_run_on: '2026-10-01' });
  });

  it('an allowance already due stays due, so the next run pays it at the new amount', async () => {
    expect(await edit('weekly-overdue', 650, 'weekly')).toEqual({ ok: true });

    expect(rule('weekly-overdue')).toMatchObject({ amount_cents: 650, next_run_on: '2026-09-27' });
    // What the cron and "Run due now" do with it next: one payment, then a week on.
    expect(rollForward(String(rule('weekly-overdue').next_run_on), 'weekly', '2026-09-28', 1)).toEqual({ runs: 1, next: '2026-10-04' });
  });

  it('writes the amount and nothing else — not the date, the cadence or the active flag', async () => {
    await edit('weekly-tomorrow', 1_200, 'weekly');

    expect(patches).toEqual([{ amount_cents: 1_200 }]);
  });

  it('a paused allowance is re-dated as before and stays paused, so resuming it does not pay the paused weeks at once', async () => {
    // Its date (08-15) is from before the pause. Kept, the edit-then-resume
    // would find the rule already due and pay it that night.
    expect(await edit('biweekly-paused', 800, 'biweekly')).toEqual({ ok: true });

    expect(rule('biweekly-paused')).toMatchObject({ amount_cents: 800, next_run_on: '2026-10-12', is_active: false });
    expect(await toggleAllowanceRuleAction({ id: 'biweekly-paused', isActive: true })).toEqual({ ok: true });
    expect(rollForward(String(rule('biweekly-paused').next_run_on), 'biweekly', '2026-09-28', 1)).toEqual({ runs: 0, next: '2026-10-12' });
  });

  it('every other rule is untouched', async () => {
    const before = snapshot();
    await edit('weekly-tomorrow', 1_200, 'weekly');

    const after = snapshot();
    expect(after.filter((r) => r.id !== 'weekly-tomorrow')).toEqual(before.filter((r) => r.id !== 'weekly-tomorrow'));
  });
});

describe('a new schedule is still made when there is a reason for one', () => {
  it('a cadence change re-dates from today, as before', async () => {
    expect(await edit('weekly-tomorrow', 1_200, 'monthly')).toEqual({ ok: true });

    expect(rule('weekly-tomorrow')).toMatchObject({ amount_cents: 1_200, cadence: 'monthly', next_run_on: '2026-10-28', is_active: true });
    expect(patches.at(-1)).toEqual({ amount_cents: 1_200, cadence: 'monthly', next_run_on: '2026-10-28' });
  });

  it('a rule with no date gets one from today, so the edit does not leave it never paying', async () => {
    expect(await edit('weekly-undated', 400, 'weekly')).toEqual({ ok: true });

    expect(rule('weekly-undated')).toMatchObject({ amount_cents: 400, next_run_on: '2026-10-05' });
  });

  it('a new rule is still dated a cadence from today and created active', async () => {
    expect(await saveAllowanceRuleAction({ childWalletId: 'wallet-f', amountCents: 800, cadence: 'weekly' })).toEqual({ ok: true });

    const created = db.table('allowance_rules').find((row) => row.child_wallet_id === 'wallet-f');
    expect(created).toMatchObject({ family_id: FAMILY, amount_cents: 800, is_active: true, next_run_on: '2026-10-05', created_by: 'user-self' });
  });
});

describe('what an edit could not do before, it still cannot do', () => {
  it('another family’s rule with the same cadence is not changed, and the action says so', async () => {
    const before = snapshot();

    expect(await edit('other-family', 1, 'weekly')).toEqual({ ok: false, error: COULD_NOT_SAVE });
    expect(snapshot()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a rule that does not exist is not reported as saved', async () => {
    expect(await saveAllowanceRuleAction({ id: 'missing', childWalletId: 'wallet-a', amountCents: 100, cadence: 'weekly' }))
      .toEqual({ ok: false, error: COULD_NOT_SAVE });
  });

  it('a failure of the amount-only write is a failure in words, not a fall-through to a new date', async () => {
    // Only the first allowance_rules update fails; a later one would go through.
    // An error here must end the edit, not hand it to the re-dating write.
    const from = db.from.bind(db);
    let failed = false;
    (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      const builder = from(name) as unknown as Record<string, unknown>;
      if (name === 'allowance_rules' && !failed) {
        builder.update = () => {
          failed = true;
          const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) };
          const chain = { eq: () => chain, not: () => chain, select: () => settle };
          return chain;
        };
      }
      return builder;
    };
    const before = snapshot();

    expect(await edit('weekly-tomorrow', 1_200, 'weekly')).toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_SAVE) });
    expect(snapshot()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('an undated rule whose dating write fails is left exactly as it was, not half-saved', async () => {
    // Review 5973286446 on #916: the amount-only write used to match an undated
    // rule (same cadence, next_run_on null), commit the new amount, and only
    // then hand over to the write that dates it — so when that second write
    // failed, the parent was told "could not save" about an amount that had
    // already changed. Every allowance_rules update after the first fails here.
    const from = db.from.bind(db);
    let updates = 0;
    (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      const builder = from(name) as unknown as Record<string, unknown>;
      if (name === 'allowance_rules') {
        const update = (builder.update as (patch: Row) => unknown).bind(builder);
        builder.update = (patch: Row) => {
          updates += 1;
          if (updates === 1) return update(patch);
          const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) };
          const chain = { eq: () => chain, not: () => chain, select: () => settle };
          return chain;
        };
      }
      return builder;
    };
    const before = snapshot();

    expect(await edit('weekly-undated', 400, 'weekly')).toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_SAVE) });
    expect(snapshot()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('an undated rule whose dating write matches nothing is left as it was, too', async () => {
    const from = db.from.bind(db);
    let updates = 0;
    (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      const builder = from(name) as unknown as Record<string, unknown>;
      if (name === 'allowance_rules') {
        const update = (builder.update as (patch: Row) => unknown).bind(builder);
        builder.update = (patch: Row) => {
          updates += 1;
          if (updates === 1) return update(patch);
          const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: null, status: 200, statusText: 'OK' }).then(resolve) };
          const chain = { eq: () => chain, not: () => chain, select: () => settle };
          return chain;
        };
      }
      return builder;
    };
    const before = snapshot();

    expect(await edit('weekly-undated', 400, 'weekly')).toEqual({ ok: false, error: COULD_NOT_SAVE });
    expect(snapshot()).toEqual(before);
  });

  it('an edit made while paused re-dates as main did, and the resume keeps that date', async () => {
    expect(await toggleAllowanceRuleAction({ id: 'weekly-tomorrow', isActive: false })).toEqual({ ok: true });
    expect(await edit('weekly-tomorrow', 1_100, 'weekly')).toEqual({ ok: true });
    expect(await toggleAllowanceRuleAction({ id: 'weekly-tomorrow', isActive: true })).toEqual({ ok: true });

    expect(rule('weekly-tomorrow')).toMatchObject({ amount_cents: 1_100, next_run_on: '2026-10-05', is_active: true });
  });

  it('a dated rule whose cadence changes, when the re-dating write fails, is left as it was', async () => {
    // The tests above that fail EVERY allowance_rules update stop at the
    // amount-only write; this one lets that write run (it matches nothing — the
    // cadence differs) so the failure lands on the update that re-dates.
    const from = db.from.bind(db);
    let updates = 0;
    (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      const builder = from(name) as unknown as Record<string, unknown>;
      if (name === 'allowance_rules') {
        const update = (builder.update as (patch: Row) => unknown).bind(builder);
        builder.update = (patch: Row) => {
          updates += 1;
          if (updates === 1) return update(patch);
          const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) };
          const chain = { eq: () => chain, not: () => chain, select: () => settle };
          return chain;
        };
      }
      return builder;
    };
    const before = snapshot();

    expect(await edit('weekly-tomorrow', 1_200, 'monthly')).toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_SAVE) });
    expect(snapshot()).toEqual(before);
    expect(updates).toBe(2);
  });
});
