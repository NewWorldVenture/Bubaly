import { describe, it, expect } from 'vitest';
import { saveBillPayment } from '@/lib/finance/bills';
import { writeBillPatch, isDueDayNotKept } from '@/lib/finance/recurring';
import { bill, store } from './helpers/recurring-bill-store';

describe('older-schema writes retain only proven original anchors', () => {
  it.each(['2026-01-15', '2026-07-31', '2026-12-31'])(
    'retries a provable date anchor %s with the same snapshot guard',
    async (due_date) => {
      const row = bill({ due_date }),
        db = store(row, true);
      const result = await saveBillPayment(db.client, row.family_id, row, due_date);
      expect(result.error).toBeNull();
      expect(result.data).toEqual([{ id: row.id }]);
      expect(db.requests).toHaveLength(2);
      expect(db.requests[1].patch).not.toHaveProperty('due_day');
      expect(db.requests[1].url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
      expect(db.current().due_date.slice(8)).toBe(due_date.slice(8));
    },
  );
  it.each([
    { day: 31, date: '2026-02-28' },
    { day: 31, date: '2026-04-30' },
    { day: 29, date: '2027-02-28' },
    { day: 30, date: '2026-02-28' },
    { day: 28, date: '2026-03-28' },
  ])('refuses loss or ambiguous reread: %j', async ({ day, date }) => {
    const writes: unknown[] = [];
    const result = await writeBillPatch(
      { status: 'upcoming', due_date: date, due_day: day },
      async (patch) => {
        writes.push(patch);
        return {
          data: null,
          error: {
            code: 'PGRST204',
            message: "Could not find the 'due_day' column of 'bills' in the schema cache",
          },
        };
      },
    );
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(writes).toHaveLength(1);
  });
  it('does not roll a clamped original bill or change its anchor', async () => {
    const row = bill(),
      db = store(row, true);
    const result = await saveBillPayment(db.client, row.family_id, row, row.due_date);
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(db.requests).toHaveLength(1);
    expect(db.current()).toEqual(row);
  });
  it('does not retry permission refusals', async () => {
    const row = bill(),
      failure = { code: '42501', message: 'bills.due_day denied' },
      db = store(row, true, failure);
    expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).error).toEqual(failure);
    expect(db.requests).toHaveLength(1);
  });
  it.each([{ is_recurring: false, recurrence: null }, { recurrence: 'weekly' }])(
    'saves schedules that need no month anchor: %j',
    async (over) => {
      const row = bill(over),
        db = store(row, true);
      expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).error).toBeNull();
      expect(db.requests).toHaveLength(1);
    },
  );
  it('keeps a stale retry from writing after an edit', async () => {
    const row = bill({ due_date: '2026-01-15' }),
      changed = bill({ due_date: row.due_date, amount: 200, updated_at: '2026-01-02T00:00:00Z' }),
      db = store(changed, true);
    expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).data).toEqual([]);
    expect(db.requests).toHaveLength(2);
    expect(db.current()).toEqual(changed);
  });
  it('refuses a new explicit month-end anchor clamped in the first date', async () => {
    const db = store(bill(), true);
    const result = await writeBillPatch({ due_date: '2026-02-28', due_day: 31 }, async (p) => {
      const error = 'due_day' in p ? { code: '42703', message: 'column bills.due_day does not exist' } : null;
      return { data: null, error };
    });
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(db.requests).toHaveLength(0);
  });
});
