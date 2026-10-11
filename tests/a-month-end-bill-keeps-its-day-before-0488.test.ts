import { describe, it, expect, vi } from 'vitest';
import { saveBillPayment, saveBillPaymentBefore0488 } from '@/lib/finance/bills';
import { writeBillPatch, isDueDayNotKept, dueDayNotKeptQuestion, billPaidPatchBefore0488, billBefore0488 } from '@/lib/finance/recurring';
import { bill, store } from './helpers/recurring-bill-store';

describe('saveBillPaymentBefore0488', () => {
  // A missing or unknown cadence is never paid as monthly (an invented
  // schedule) nor closed as a one-off: the caller asks for the schedule.
  it.each([null, '', 'every month', 'constructor'])('answers null for cadence %j without probing or writing', async (recurrence) => {
    const row = bill({ due_date: '2026-02-28', recurrence }),
      db = store(row, true);
    expect(await saveBillPaymentBefore0488(db.client, row.family_id, row, row.due_date)).toBeNull();
    expect(db.reads).toHaveLength(0);
    expect(db.requests).toHaveLength(0);
    expect(db.current()).toEqual(row);
  });
  it('the pre-0488 patch for an unnamed cadence is null, and writeBillPatch then writes nothing', async () => {
    for (const recurrence of [null, 'every month']) {
      const row = bill({ due_date: '2026-01-15', recurrence });
      expect(billPaidPatchBefore0488(row, row.due_date)).toBeNull();
      const write = vi.fn(async () => ({ data: [], error: null }));
      const result = await writeBillPatch(billPaidPatchBefore0488(row, row.due_date), write, { dueDayMissing: true });
      expect(result.error).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
    }
    // A one-off and a named cadence are unchanged.
    expect(billPaidPatchBefore0488(bill({ is_recurring: false, recurrence: null }), '2026-01-31')).toEqual({ status: 'paid' });
    expect(billPaidPatchBefore0488(bill({ due_date: '2026-01-15', recurrence: 'Monthly' }), '2026-01-15')).toEqual({ status: 'upcoming', due_date: '2026-02-15', due_day: 15 });
  });
  it('billBefore0488 leaves an unnamed cadence unknown and anchors a named one on its date', () => {
    expect(billBefore0488(bill({ due_date: '2026-01-29', recurrence: null }))).toMatchObject({ recurrence: null });
    expect(billBefore0488(bill({ due_date: '2026-01-29', recurrence: null }))).not.toHaveProperty('due_day');
    expect(billBefore0488(bill({ due_date: '2026-01-15', recurrence: 'every month' }))).toMatchObject({ recurrence: 'every month' });
    expect(billBefore0488(bill({ due_date: '2026-01-15', recurrence: 'Monthly' }))).toMatchObject({ recurrence: 'monthly', due_day: 15 });
  });
  it('answers null (ask for the schedule) when the column exists or the row carries it', async () => {
    const row = bill({ due_date: '2026-03-30' }),
      db = store(row);
    expect(await saveBillPaymentBefore0488(db.client, row.family_id, row, row.due_date)).toBeNull();
    expect(db.requests).toHaveLength(0);
    const anchored = bill({ due_date: '2026-03-30', due_day: null }),
      none = store(anchored, true);
    expect(await saveBillPaymentBefore0488(none.client, anchored.family_id, anchored, anchored.due_date)).toBeNull();
    expect(none.reads).toHaveLength(0);
  });
  it('returns any other probe refusal as the error and writes nothing', async () => {
    const failure = { code: '42703', message: 'column bills.amount does not exist' },
      row = bill({ due_date: '2026-03-30' }),
      db = store(row, true, failure);
    const result = await saveBillPaymentBefore0488(db.client, row.family_id, row, row.due_date);
    expect(result?.error).toMatchObject(failure);
    expect(db.requests).toHaveLength(0);
  });
});

describe('older-schema writes fall back to the pre-0488 behaviour', () => {
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
  ])('refuses a clamp nobody confirmed: %j', async ({ day, date }) => {
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
  // Owner decision (0488 held): a day 28–30 on its own date is written as it
  // was before 0488, where it used to be refused as ambiguous.
  it.each([
    { day: 28, date: '2026-03-28' },
    { day: 29, date: '2026-03-29' },
    { day: 30, date: '2026-04-30' },
  ])('writes a day 28-30 that its date carries without the column: %j', async ({ day, date }) => {
    const writes: Record<string, unknown>[] = [];
    const result = await writeBillPatch({ status: 'upcoming', due_date: date, due_day: day }, async (patch) => {
      writes.push(patch);
      return 'due_day' in patch
        ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" } }
        : { data: [{ id: 'synthetic-bill' }], error: null };
    });
    expect(result.error).toBeNull();
    expect(writes).toEqual([{ status: 'upcoming', due_date: date, due_day: day }, { status: 'upcoming', due_date: date }]);
  });
  it.each([
    { old: true, failure: null, writes: 2 },
    { old: false, failure: null, writes: 1 },
    { old: true, failure: { code: '42501', message: 'permission denied for table bills' }, writes: 1 },
  ])('creates a recurring bill due on the 30th (older schema $old, refusal $failure)', async ({ old, failure, writes }) => {
    const db = store(bill(), old, failure);
    const created = {
      family_id: 'synthetic-family', name: 'Rent', amount: 100, due_date: '2026-10-30', due_day: 30,
      is_recurring: true, recurrence: 'monthly', status: 'upcoming' as const, created_by: null,
    };
    const result = await writeBillPatch(created, (p) => db.client.from('bills').insert(p));
    expect(db.requests).toHaveLength(writes);
    expect(db.requests[0].patch).toMatchObject({ due_day: 30 });
    if (failure) expect(result.error).toMatchObject(failure);
    else expect(result.error).toBeNull();
    if (old && !failure) {
      const { due_day: _day, ...withoutDay } = created;
      expect(db.requests[1].patch).toEqual(withoutDay);
    }
  });
  it('asks before a clamp and writes it without the column only on yes', async () => {
    for (const answer of [false, true]) {
      const writes: Record<string, unknown>[] = [];
      const confirmClampedDay = vi.fn(async () => answer);
      const result = await writeBillPatch(
        { status: 'upcoming', due_date: '2026-02-28', due_day: 31 },
        async (patch) => {
          writes.push(patch);
          return 'due_day' in patch
            ? { data: null, error: { code: '42703', message: 'column bills.due_day does not exist' } }
            : { data: [{ id: 'synthetic-bill' }], error: null };
        },
        { confirmClampedDay },
      );
      expect(confirmClampedDay).toHaveBeenCalledWith(expect.objectContaining({ day: 31, dueDate: '2026-02-28' }));
      if (answer) {
        expect(result.error).toBeNull();
        expect(writes[1]).toEqual({ status: 'upcoming', due_date: '2026-02-28' });
      } else {
        expect(isDueDayNotKept(result.error)).toBe(true);
        expect(writes).toHaveLength(1);
      }
    }
  });
  it('never asks or retries when the refusal is not the missing column', async () => {
    const confirmClampedDay = vi.fn(async () => true);
    const failure = { code: 'PGRST204', message: "Could not find the 'due_day_backup' column of 'bills' in the schema cache" };
    const writes: unknown[] = [];
    const result = await writeBillPatch({ due_date: '2026-02-28', due_day: 31 }, async (patch) => {
      writes.push(patch);
      return { data: null, error: failure };
    }, { confirmClampedDay });
    expect(result.error).toBe(failure);
    expect(writes).toHaveLength(1);
    expect(confirmClampedDay).not.toHaveBeenCalled();
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

// Review follow-ups: the pre-0488 write sends exactly what 82f2db1 sent.
describe('pre-0488 writes match the previous production requests', () => {
  // A month-based roll learns the column is missing from the refused due_day;
  // a weekly-type roll sends no due_day, and its row was read without the key.
  it.each([
    { recurrence: 'Monthly', writes: 2, next: '2026-02-15' },
    { recurrence: 'annually', writes: 2, next: '2027-01-15' },
    { recurrence: 'fortnightly', writes: 1, next: '2026-01-29' },
  ])('leaves a stored cadence spelled $recurrence as stored without the column', async ({ recurrence, writes, next }) => {
    const row = bill({ due_date: '2026-01-15', recurrence }),
      db = store(row, true);
    const result = await saveBillPayment(db.client, row.family_id, row, row.due_date);
    expect(result.error).toBeNull();
    expect(db.requests).toHaveLength(writes);
    expect(db.requests.at(-1)!.patch).toEqual({ status: 'upcoming', due_date: next });
    expect(db.requests.at(-1)!.url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
    expect(db.requests.at(-1)!.url.searchParams.get('recurrence')).toBe(`eq.${recurrence}`);
    expect(db.current()).toMatchObject({ recurrence, due_date: next });
  });
  it.each([
    { recurrence: 'Monthly', due_day: 15, patch: { status: 'upcoming', due_date: '2026-02-15', recurrence: 'monthly', due_day: 15 } },
    { recurrence: 'fortnightly', due_day: null, patch: { status: 'upcoming', due_date: '2026-01-29', recurrence: 'biweekly' } },
  ])('still writes the normalized cadence when the column exists ($recurrence)', async ({ recurrence, due_day, patch }) => {
    const row = bill({ due_date: '2026-01-15', recurrence, due_day }),
      db = store(row);
    expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).error).toBeNull();
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0].patch).toEqual(patch);
  });
  it('keeps a cadence that is not the stored one, and surfaces another refusal unchanged', async () => {
    const writes: Record<string, unknown>[] = [];
    const missing = { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" };
    const result = await writeBillPatch({ due_date: '2026-01-15', recurrence: 'quarterly', due_day: 15 }, async (p) => {
      writes.push(p);
      return 'due_day' in p ? { data: null, error: missing } : { data: [{ id: 'synthetic-bill' }], error: null };
    }, { storedRecurrence: 'monthly' });
    expect(result.error).toBeNull();
    expect(writes[1]).toEqual({ due_date: '2026-01-15', recurrence: 'quarterly' });
    const row = bill({ due_date: '2026-01-15', recurrence: 'Monthly' }),
      failure = { code: '42501', message: 'permission denied for table bills' },
      db = store(row, true, failure);
    expect((await saveBillPayment(db.client, row.family_id, row, row.due_date)).error).toEqual(failure);
    expect(db.requests).toHaveLength(1);
  });
  it('pays without sending due_day once the probe has answered that it is missing', async () => {
    const row = bill({ due_date: '2026-03-30' }),
      db = store(row, true);
    const result = await saveBillPaymentBefore0488(db.client, row.family_id, row, row.due_date);
    expect(result?.error).toBeNull();
    expect(db.reads).toHaveLength(1);
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0].patch).toEqual({ status: 'upcoming', due_date: '2026-04-30' });
    expect(db.requests[0].url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
  });
  it('still asks before a clamp when it skips the refused write', async () => {
    for (const answer of [false, true]) {
      const row = bill({ due_date: '2026-01-30' }),
        db = store(row, true),
        confirmClampedDay = vi.fn(async () => answer);
      const result = await saveBillPaymentBefore0488(db.client, row.family_id, row, row.due_date, undefined, { confirmClampedDay });
      expect(confirmClampedDay).toHaveBeenCalledWith(expect.objectContaining({ day: 30, dueDate: '2026-02-28' }));
      if (answer) {
        expect(result?.error).toBeNull();
        expect(db.requests).toHaveLength(1);
        expect(db.requests[0].patch).toEqual({ status: 'upcoming', due_date: '2026-02-28' });
      } else {
        expect(isDueDayNotKept(result?.error)).toBe(true);
        expect(db.requests).toHaveLength(0);
        expect(db.current()).toEqual(row);
      }
    }
  });
  it('returns a refusal of the column-less write as it came', async () => {
    const failure = { code: '42501', message: 'permission denied for table bills' };
    const writes: unknown[] = [];
    const result = await writeBillPatch({ status: 'upcoming', due_date: '2026-04-30', due_day: 30 }, async (p) => {
      writes.push(p);
      return { data: null, error: failure };
    }, { dueDayMissing: true });
    expect(result.error).toBe(failure);
    expect(writes).toEqual([{ status: 'upcoming', due_date: '2026-04-30' }]);
  });
  it('asks an add question, not a mark-paid one, for a new bill', () => {
    const t = (key: string) => key;
    const refusal = { code: 'BUBALY_DUE_DAY_NOT_KEPT', message: '', day: 31, dueDate: '2026-04-30' } as Parameters<typeof dueDayNotKeptQuestion>[0];
    expect(dueDayNotKeptQuestion(refusal, t, (d) => d, 'en-US', 'add')).toMatchObject({
      title: 'bills.addOnShorterMonthTitle', confirmLabel: 'bills.addOnShorterMonthConfirm', cancelLabel: 'bills.cancel', destructive: false,
    });
    expect(dueDayNotKeptQuestion(refusal, t, (d) => d, 'en-US')).toMatchObject({ title: 'bills.moveToShorterMonthTitle' });
  });
});
