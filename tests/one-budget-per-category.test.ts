// `budgets` has no unique index on the category, and `updateBudget` reads then
// inserts. Two parents saving "Groceries" at once both miss and both insert;
// legacy forms left duplicates behind too. `budgetVsActual` then summed the
// same Groceries spend into every duplicate line and `totalSpent` added the
// lines together, so the family's spend was counted twice, and `.limit(1)`
// with no order edited whichever duplicate came back first.
//
// The unique index needs a migration (merge duplicates, then index
// (family_id, lower(btrim(category)))). Until then the service settles it:
// the OLDEST row is the category's budget for readers and writers alike, and a
// save that lost the race folds its row into the winner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { budgetVsActual, updateBudget } from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1',
  role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-15T12:00:00Z'),
});
const budgets = () => db.table('budgets');

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { audit_logs: { resource_id: null, metadata: null } },
  });
  db.seed('transactions', [
    { id: 't-1', family_id: FAMILY, name: 'Market', amount: 120, category: 'Groceries', date: '2026-09-03', type: 'expense', status: 'posted' },
    { id: 't-2', family_id: FAMILY, name: 'Market', amount: 80, category: 'groceries', date: '2026-09-10', type: 'expense', status: 'posted' },
  ]);
});

describe('a category with two budget rows', () => {
  beforeEach(() => {
    // Seeded newest first, so "whatever came back first" is the WRONG one.
    db.seed('budgets', [
      { id: 'b-new', family_id: FAMILY, category: 'groceries', amount: 300, period: 'monthly', created_at: '2026-05-01T00:00:00Z' },
      { id: 'b-old', family_id: FAMILY, category: 'Groceries', amount: 500, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('counts the spend once', async () => {
    const res = await budgetVsActual(scope());
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.data.budgets).toHaveLength(1);
    expect(res.data.totalSpent).toBe(200);
    expect(res.data.totalLimit).toBe(500);
    expect(res.data.budgets[0]).toMatchObject({ budgetId: 'b-old', spent: 200 });
  });

  it('edits the row the overview reports', async () => {
    const res = await updateBudget(scope(), { category: 'GROCERIES', amount: 650 });
    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 500, budget: { id: 'b-old' } } });
    expect(budgets().find((b) => b.id === 'b-old')?.amount).toBe(650);
    expect(budgets().find((b) => b.id === 'b-new')?.amount).toBe(300);

    const after = await budgetVsActual(scope());
    expect(after.ok && after.data.budgets[0]).toMatchObject({ budgetId: 'b-old', limit: 650 });
  });
});

describe('two saves of a new category racing', () => {
  it('leave one budget, carrying the later save\'s amount', async () => {
    // The other parent's save lands between our lookup (which found nothing)
    // and our insert — exactly the window the read-then-insert leaves open.
    const real = db.from.bind(db);
    let lookups = 0;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      if (table === 'budgets' && ++lookups === 2) {
        db.seed('budgets', [{ id: 'theirs', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
      }
      return real(table);
    });

    const res = await updateBudget(scope(), { category: 'Groceries', amount: 450 });
    vi.restoreAllMocks();

    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 400, budget: { id: 'theirs', amount: 450 } } });
    expect(budgets()).toHaveLength(1);
    expect(budgets()[0]).toMatchObject({ id: 'theirs', amount: 450 });

    const overview = await budgetVsActual(scope());
    expect(overview.ok && overview.data.totalSpent).toBe(200);
  });

  it('a save with no rival still creates the budget', async () => {
    const res = await updateBudget(scope(), { category: 'Fuel', amount: 90 });
    expect(res).toMatchObject({ ok: true, data: { created: true, previousAmount: null } });
    expect(budgets()).toHaveLength(1);
  });
});

describe('a save that lost the race but cannot remove its duplicate', () => {
  // The race above, with the cleanup delete going wrong. Readers select the
  // OLDEST row, so the requested amount has to land on the winner whatever
  // became of our duplicate. Answering `created: true` with OUR row instead
  // reports success while the family's Groceries budget still reads 400.
  //
  // `updateBudget` touches `budgets` five times: lookup, insert, the winner
  // check, the duplicate delete, the winner update. The rival lands before the
  // insert; the delete is where each case differs.
  const DELETE = 4;
  const theirs = { id: 'theirs', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' };
  type Builder = ReturnType<typeof db.from>;

  const raceWhoseDelete = (shape: (builder: Builder) => Builder) => {
    const real = db.from.bind(db);
    let calls = 0;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      if (table !== 'budgets') return real(table);
      calls += 1;
      if (calls === 2) db.seed('budgets', [theirs]);
      const builder = real(table);
      return calls === DELETE ? shape(builder) : builder;
    });
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  afterEach(() => vi.restoreAllMocks());

  it('matched no row: the amount still lands on the winner', async () => {
    const errors = raceWhoseDelete((builder) => {
      // Another actor removed our duplicate first, so the delete finds nothing.
      db.replace('budgets', budgets().filter((b) => b.id === 'theirs'));
      return builder;
    });

    const res = await updateBudget(scope(), { category: 'Groceries', amount: 450 });

    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 400, budget: { id: 'theirs', amount: 450 } } });
    expect(budgets()).toEqual([expect.objectContaining({ id: 'theirs', amount: 450 })]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('already gone'), expect.objectContaining({ winnerId: 'theirs' }));

    const overview = await budgetVsActual(scope());
    expect(overview.ok && overview.data.budgets[0]).toMatchObject({ budgetId: 'theirs', limit: 450 });
  });

  it('errored: the amount still lands on the winner and the error is logged', async () => {
    const timeout = { code: '57014', message: 'canceling statement due to statement timeout', details: '', hint: '' };
    const errors = raceWhoseDelete((builder) => Object.assign(builder, {
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: timeout, count: null, status: 500, statusText: 'Internal Server Error' }).then(onFulfilled, onRejected),
    }));

    const res = await updateBudget(scope(), { category: 'Groceries', amount: 450 });

    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 400, budget: { id: 'theirs', amount: 450 } } });
    // Our duplicate is left behind — the log says it may remain — but the row
    // the family reads carries the amount they asked for.
    expect(budgets()).toHaveLength(2);
    expect(budgets().find((b) => b.id === 'theirs')?.amount).toBe(450);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('may remain'), expect.objectContaining({ winnerId: 'theirs', error: timeout }));

    const overview = await budgetVsActual(scope());
    expect(overview.ok && overview.data.budgets[0]).toMatchObject({ budgetId: 'theirs', limit: 450 });
  });

  it('succeeded: one budget, the winner, at the requested amount (control)', async () => {
    const errors = raceWhoseDelete((builder) => builder);

    const res = await updateBudget(scope(), { category: 'Groceries', amount: 450 });

    expect(res).toMatchObject({ ok: true, data: { created: false, previousAmount: 400, budget: { id: 'theirs', amount: 450 } } });
    expect(budgets()).toEqual([expect.objectContaining({ id: 'theirs', amount: 450 })]);
    expect(errors).not.toHaveBeenCalled();
  });
});
