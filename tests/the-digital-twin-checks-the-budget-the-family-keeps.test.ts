// TWIN-SIB — the Family Digital Twin checks a cost against the budget the
// family keeps, in that budget's own period on the family's day, and only for
// someone who may read the household's money.
//
// The Decision Simulator's spend check and the activity projection's Cost line
// each repeated three defects the money screens had already shed:
//
//   M14  the period had a start and no end, so next month's scheduled rent was
//        this month's spending;
//   M11  the period began on Greenwich's day with Monday weeks, where every
//        budget screen keeps Sunday-to-Saturday weeks on the family's day;
//   M13  the budget was whichever row `.find` met first in an unordered read,
//        so a later duplicate could stand in for the budget the finance
//        service edits.
//
// And the projection had no household-money gate: a child who named a budget
// got the Cost line back with the household's "$X of $Y used".
//
// Both server actions are driven for real against an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', tz: 'UTC' }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: harness.role, member: { id: 'member-1' }, family: { id: 'family-1', timezone: harness.tz } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
  };
});

const { simulateDecisionAction, projectActivityAction } = await import('@/app/(app)/dashboard/family-digital-twin/actions');

let db: InMemorySupabase;
let seq = 0;
const expense = (date: string, amount: number, category: string, status = 'posted') =>
  ({ id: `t-${String(++seq).padStart(5, '0')}`, family_id: FAMILY, name: category, amount, category, date, type: 'expense', status });
const budget = (category: string, amount: number, period: string, createdAt = '2026-01-01T00:00:00Z') =>
  ({ id: `b-${String(++seq).padStart(5, '0')}`, family_id: FAMILY, category, amount, period, created_at: createdAt });

const spend = (category: string, amountDollars: number) =>
  simulateDecisionAction({ kind: 'spend', label: 'Purchase', category, amountDollars });

/** A Saturday-morning activity: no school night, no dinner, so Cost is the line in question. */
const activity = (extra: { costDollars?: number; costCategory?: string } = {}) => projectActivityAction({
  memberId: 'member-2', memberName: 'Emma', activityName: 'Travel soccer',
  startsAt: '2026-10-17T10:00:00Z', durationMin: 90, sessionsPerWeek: 1, weeks: 4, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  harness.role = 'parent';
  harness.tz = 'UTC';
  seq = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the spend simulation checks the budget the family keeps', () => {
  it('next month\'s scheduled rows are not this month\'s spending', async () => {
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    db.seed('transactions', [expense('2026-10-02', 250, 'Groceries'), expense('2026-11-01', 900, 'Groceries', 'scheduled')]);

    const result = await spend('Groceries', 20);
    expect(result.verdict).toBe('clear');
    expect(result.impacts[0].detail).toBe('$270 of $300 used.');
  });

  it('a weekly budget is the family\'s Sunday-to-Saturday week, on the family\'s day', async () => {
    // 20:00 on Saturday 10 October in Los Angeles; Sunday the 11th at Greenwich.
    harness.tz = 'America/Los_Angeles';
    vi.setSystemTime(new Date('2026-10-11T03:00:00Z'));
    db.seed('budgets', [budget('Groceries', 100, 'weekly')]);
    // Sunday the 4th opened the family's week; Greenwich's Monday weeks began on the 5th.
    db.seed('transactions', [expense('2026-10-04', 80, 'Groceries'), expense('2026-10-10', 15, 'Groceries')]);

    const result = await spend('Groceries', 10);
    expect(result.verdict).toBe('conflict');
    expect(result.impacts[0]).toMatchObject({ severity: 'blocker', title: 'Over budget by $5', detail: '$105 of a $100 “Groceries” budget.' });
  });

  it('a later duplicate budget does not stand in for the one the family keeps', async () => {
    db.seed('budgets', [
      // Met first by an unordered read, created after the real one.
      budget('groceries', 5000, 'monthly', '2026-06-01T00:00:00Z'),
      budget('Groceries', 300, 'monthly'),
    ]);
    db.seed('transactions', [expense('2026-10-02', 250, 'Groceries')]);

    const result = await spend('Groceries', 100);
    expect(result.verdict).toBe('conflict');
    expect(result.impacts[0]).toMatchObject({ title: 'Over budget by $50', detail: '$350 of a $300 “Groceries” budget.' });
  });
});

describe('the activity projection\'s Cost line', () => {
  it('is a parent\'s or adult\'s: a child who names a budget gets the projection without it, and nothing is read', async () => {
    harness.role = 'child';
    db.seed('budgets', [budget('Kids', 300, 'monthly')]);
    db.seed('transactions', [expense('2026-10-02', 250, 'Kids')]);

    const result = await activity({ costDollars: 40, costCategory: 'Kids' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dimensions.map((d) => d.key)).toContain('schedule');
    expect(result.data.dimensions.map((d) => d.key)).not.toContain('cost');
    expect(JSON.stringify(result)).not.toContain('$300');
    expect(JSON.stringify(result)).not.toContain('$250');
    expect(db.log.map((entry) => entry.table)).not.toContain('budgets');
    expect(db.log.map((entry) => entry.table)).not.toContain('transactions');
  });

  it('a child still gets the projection of an activity with no cost', async () => {
    harness.role = 'child';
    const result = await activity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dimensions.map((d) => d.key)).not.toContain('cost');
  });

  it('a parent\'s Cost line is the kept budget against its own period, both ends', async () => {
    db.seed('budgets', [
      budget('kids', 5000, 'monthly', '2026-06-01T00:00:00Z'),
      budget('Kids', 300, 'monthly'),
    ]);
    db.seed('transactions', [expense('2026-10-02', 250, 'Kids'), expense('2026-11-01', 900, 'Kids', 'scheduled')]);

    const result = await activity({ costDollars: 40, costCategory: 'Kids' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $250 of October's $300, not $1,150 of a duplicate's $5,000: $10 left after it.
    expect(result.data.dimensions.find((d) => d.key === 'cost')).toMatchObject({ severity: 'caution', detail: '$290 of $300 used.' });
  });
});
