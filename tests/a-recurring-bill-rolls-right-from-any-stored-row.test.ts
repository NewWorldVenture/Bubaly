import { describe, it, expect } from 'vitest';
import { billPaidPatch } from '@/lib/finance/recurring';
import { saveBillPayment } from '@/lib/finance/bills';
import { bill, store } from './helpers/recurring-bill-store';

describe('a stored bill requires an explicit schedule and fresh snapshot', () => {
  it.each(['2026-02-28', '2028-02-29', '2026-04-30', '2026-03-28', '2026-03-29', '2026-03-30'])(
    'does not infer an original anchor from %s',
    async (due_date) => {
      const row = bill({ due_date }),
        db = store(row);
      expect(billPaidPatch(row, due_date)).toBeNull();
      expect((await saveBillPayment(db.client, row.family_id, row, due_date)).error).toBeTruthy();
      expect(db.requests).toHaveLength(0);
      expect(db.current()).toEqual(row);
    },
  );
  it.each([null, '', 'semimonthly', 'constructor'])('does not invent cadence %s', async (recurrence) => {
    const row = bill({ recurrence }),
      db = store(row);
    expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).error).toBeTruthy();
    expect(db.requests).toHaveLength(0);
    expect(
      (
        await saveBillPayment(db.client, row.family_id, row, row.due_date, {
          cadence: 'quarterly',
          dueDay: 31,
        })
      ).error,
    ).toBeNull();
    expect(db.current()).toMatchObject({ recurrence: 'quarterly', due_date: '2026-04-30', due_day: 31 });
  });
  it('rejects an invalid recurring date even after explicit confirmation', async () => {
    const row = bill({ due_date: '2026-02-30' }),
      db = store(row);
    const result = await saveBillPayment(db.client, row.family_id, row, '2026-02-28', {
      cadence: 'monthly',
      dueDay: 31,
    });
    expect(result.error).toBeTruthy();
    expect(db.requests).toHaveLength(0);
    expect(db.current().status).toBe('upcoming');
  });
  it('admits exactly one of two overlapping payments', async () => {
    const row = bill(),
      db = store(row);
    const results = await Promise.all([
      saveBillPayment(db.client, row.family_id, row, row.due_date),
      saveBillPayment(db.client, row.family_id, row, row.due_date),
    ]);
    expect(results.map((r) => r.data?.length).sort()).toEqual([0, 1]);
    expect(db.current().due_date).toBe('2026-02-28');
    expect(db.requests[0].url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
  });
  it.each([{ amount: 200 }, { autopay: true }, { due_day: 29 }, { recurrence: 'quarterly' }])(
    'rejects an edit after rendering: %j',
    async (over) => {
      const seen = bill({ due_day: 31 }),
        changed = bill({ ...over, updated_at: '2026-01-02T00:00:00Z' }),
        db = store(changed);
      expect((await saveBillPayment(db.client, seen.family_id, seen, seen.due_date)).data).toEqual([]);
      expect(db.current()).toEqual(changed);
    },
  );
  it('rejects schedule ABA and missing snapshots', async () => {
    const seen = bill(),
      db = store(bill({ updated_at: '2026-01-03T00:00:00Z' }));
    expect((await saveBillPayment(db.client, seen.family_id, seen, seen.due_date)).data).toEqual([]);
    const before = db.requests.length;
    expect((await saveBillPayment(db.client, seen.family_id, null, seen.due_date)).error).toBeTruthy();
    expect(db.requests).toHaveLength(before);
    expect(
      (await saveBillPayment(db.client, seen.family_id, { ...seen, updated_at: '' }, seen.due_date)).error,
    ).toBeTruthy();
    expect(db.requests).toHaveLength(before);
  });
  it('keeps family scope', async () => {
    const seen = bill(),
      db = store(bill({ family_id: 'other-family' }));
    expect((await saveBillPayment(db.client, seen.family_id, seen, seen.due_date)).data).toEqual([]);
  });
});
