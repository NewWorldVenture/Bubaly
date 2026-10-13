// The Family Operating Index's "overspent budgets" count and Family
// Intelligence's budget-drift signal judge the budget the family keeps, in its
// own period on the family's day (TWIN-SIB-FOI).
//
// Both are the twin's defect again (TWIN-SIB): each budget's period started on
// Greenwich's day, with Monday weeks, and had no end, so next month's scheduled
// rent was this month's overspend; every budget row was judged, so a legacy
// duplicate's smaller limit counted a category over that the family's own
// budget was not; and the year of expenses was read on offsets, so a row
// written between two pages pushed one row onto the next page and it was
// summed twice.
//
// Driven through the real snapshot build (lib/operating-index/server.ts
// buildSnapshot) and the real signal scan (lib/intelligence/hard-signals-server.ts
// runSignalDetection), over an in-memory database capped at PostgREST's
// db-max-rows. Every instant is pinned and every family names its zone, so the
// cases hold under any host TZ.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildSnapshot } from '@/lib/operating-index/server';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';

type DB = SupabaseClient<Database>;
const FAMILY = 'family-foi';
const LOS_ANGELES = 'America/Los_Angeles';
// The stored words are not under test; an echo translator is enough.
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;

let db: InMemorySupabase;
let seq = 0;
const id = (prefix: string) => `${prefix}-${String(++seq).padStart(6, '0')}`;

function budget(category: string, amount: number, period: 'weekly' | 'monthly' | 'yearly', createdAt = '2026-01-01T00:00:00Z') {
  return { id: id('b'), family_id: FAMILY, category, amount, period, created_by: null, created_at: createdAt };
}
function expense(date: string, amount: number, category: string, extra: Record<string, unknown> = {}) {
  return { id: id('t'), family_id: FAMILY, name: category, amount, category, date, type: 'expense', status: 'posted', member_id: null, ...extra };
}

/** The Operating Index's count of budgets over their cap, from the real snapshot build. */
async function overspent(now: Date, tz = 'UTC', client: unknown = db): Promise<number> {
  return (await buildSnapshot(client as DB, FAMILY, tz, now)).overspentBudgets;
}

/** The budget-drift signals the real scan stores, by category. */
async function drift(now: Date, tz = 'UTC', client: unknown = db): Promise<Record<string, unknown>[]> {
  const result = await runSignalDetection(client as DB, FAMILY, 'en-US', echo, now, tz);
  expect(result).toMatchObject({ ok: true });
  return db.table('family_signals').filter((row) => row.kind === 'budget_drift').map((row) => row.evidence as Record<string, unknown>);
}

/** Every read through, plus one write before the transactions read's second page: a January row, ahead of every id. */
function writtenBetweenPages(): { client: unknown; pages: () => number } {
  let pages = 0;
  const client = withFaults(db, (table) => {
    if (table === 'transactions' && ++pages === 2) {
      db.seed('transactions', [{ id: 't-00000', family_id: FAMILY, name: 'Vet', amount: 80, category: 'Pets', date: '2026-01-05', type: 'expense', status: 'posted', member_id: null }]);
    }
    return null;
  });
  return { client, pages: () => pages };
}

beforeEach(() => {
  seq = 0;
  db = createInMemorySupabase({
    maxRows: 1000,
    uniques: { family_signals: [['family_id', 'kind', 'subject_key']] },
    defaults: { family_signals: { status: 'active' } },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const OCTOBER_13 = new Date('2026-10-13T12:00:00Z');

describe('a period ends where it ends', () => {
  beforeEach(() => {
    db.seed('budgets', [budget('Housing', 2000, 'monthly')]);
    db.seed('transactions', [
      expense('2026-10-01', 2000, 'Housing'),
      // Next month's rent, recorded today as scheduled.
      expense('2026-11-01', 2000, 'Housing', { status: 'scheduled' }),
    ]);
  });

  it('next month\'s scheduled rent does not make this month\'s Housing budget overspent on the index', async () => {
    expect(await overspent(OCTOBER_13)).toBe(0);
  });

  it('nor a budget-drift signal', async () => {
    expect(await drift(OCTOBER_13)).toEqual([]);
  });
});

describe('one budget per category, the one the family keeps', () => {
  beforeEach(() => {
    db.seed('budgets', [
      budget('Housing', 2500, 'monthly'),
      // A legacy duplicate, created later: not the budget the finance service edits.
      budget('housing', 100, 'monthly', '2026-06-01T00:00:00Z'),
    ]);
    db.seed('transactions', [expense('2026-10-01', 2000, 'Housing')]);
  });

  it('the duplicate\'s $100 does not count Housing as overspent on the index', async () => {
    expect(await overspent(OCTOBER_13)).toBe(0);
  });

  it('nor raise a budget-drift signal', async () => {
    expect(await drift(OCTOBER_13)).toEqual([]);
  });

  it('and an over budget is judged against the limit the family keeps, once', async () => {
    db.seed('transactions', [expense('2026-10-02', 700, 'housing')]);
    expect(await overspent(OCTOBER_13)).toBe(1);
    expect(await drift(OCTOBER_13)).toEqual([expect.objectContaining({ category: 'Housing', limit: 2500, spent: 2700, overBy: 200 })]);
  });
});

describe('the period is the family\'s, Sunday to Saturday', () => {
  // 22:00 on Sunday 11 October in Los Angeles: Monday at Greenwich, whose
  // Monday week had not begun on the family's Sunday.
  const SUNDAY_NIGHT_IN_CALIFORNIA = new Date('2026-10-12T05:00:00Z');

  beforeEach(() => {
    db.seed('budgets', [budget('Groceries', 100, 'weekly')]);
    db.seed('transactions', [expense('2026-10-11', 150, 'Groceries')]);
  });

  it('Sunday\'s shop is this week\'s on the index', async () => {
    expect(await overspent(SUNDAY_NIGHT_IN_CALIFORNIA, LOS_ANGELES)).toBe(1);
  });

  it('and in the signal', async () => {
    expect(await drift(SUNDAY_NIGHT_IN_CALIFORNIA, LOS_ANGELES)).toEqual([expect.objectContaining({ category: 'Groceries', period: 'weekly', spent: 150, overBy: 50 })]);
  });
});

describe('the family\'s year is read whole on its last evening', () => {
  // 21:30 on 31 December 2026 in Los Angeles: already 2027 at Greenwich, whose
  // year began after every row of the family's.
  const NEW_YEARS_EVE_IN_CALIFORNIA = new Date('2027-01-01T05:30:00Z');

  beforeEach(() => {
    db.seed('budgets', [budget('Travel', 1000, 'yearly')]);
    db.seed('transactions', [expense('2026-06-01', 1500, 'Travel')]);
  });

  it('the summer\'s trip is this year\'s on the index', async () => {
    expect(await overspent(NEW_YEARS_EVE_IN_CALIFORNIA, LOS_ANGELES)).toBe(1);
  });

  it('and in the signal', async () => {
    expect(await drift(NEW_YEARS_EVE_IN_CALIFORNIA, LOS_ANGELES)).toEqual([expect.objectContaining({ category: 'Travel', period: 'yearly', spent: 1500, overBy: 500 })]);
  });
});

describe('the year of expenses is read once, row by row, while it is written to', () => {
  beforeEach(() => {
    // October: 1,500 one-dollar shops, exactly the budget, past the 1,000-row cap.
    db.seed('budgets', [budget('Groceries', 1500, 'monthly')]);
    db.seed('transactions', Array.from({ length: 1500 }, (_, i) => expense(`2026-10-${String(1 + (i % 12)).padStart(2, '0')}`, 1, 'Groceries')));
  });

  it('a row recorded between two pages does not count a shop twice on the index', async () => {
    const { client, pages } = writtenBetweenPages();
    expect(await overspent(OCTOBER_13, 'UTC', client)).toBe(0);
    expect(pages()).toBeGreaterThan(1);
  });

  it('nor in the signal', async () => {
    const { client, pages } = writtenBetweenPages();
    expect(await drift(OCTOBER_13, 'UTC', client)).toEqual([]);
    expect(pages()).toBeGreaterThan(1);
  });

  it('a year past the read\'s ceiling is a failed read, not a count from part of it', async () => {
    db.seed('transactions', Array.from({ length: 5000 }, () => expense('2026-03-01', 1, 'Pets')));
    await expect(buildSnapshot(db as unknown as DB, FAMILY, 'UTC', OCTOBER_13)).rejects.toBeTruthy();
    const result = await runSignalDetection(db as unknown as DB, FAMILY, 'en-US', echo, OCTOBER_13, 'UTC');
    expect(result.ok).toBe(false);
    expect(db.table('family_signals')).toEqual([]);
  });
});
