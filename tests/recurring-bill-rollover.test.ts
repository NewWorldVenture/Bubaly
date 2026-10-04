import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { billAnchorDay, billCadence, billPaidPatch, billDateForAnchorDay, newBillDueDay, nextBillDueDate } from '@/lib/finance/hub';
import { isMissingBillDueDay, saveBillPayment } from '@/lib/finance/bills';
import { buildCashflowTimeline } from '@/lib/finance/timeline';

const bill = (over: Partial<Tables<'bills'>> = {}): Tables<'bills'> => ({
  id: 'bill-1', family_id: 'family-1', name: 'Synthetic rent', amount: 100,
  due_date: '2026-01-31', due_day: null, is_recurring: true, recurrence: 'monthly',
  status: 'upcoming', category: null, autopay: false, created_by: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});

function store(initial: Tables<'bills'>, options: { oldSchema?: boolean; error?: string; overlap?: boolean } = {}) {
  let row = { ...initial };
  const requests: { url: URL; patch: Record<string, unknown> }[] = [];
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => { release = resolve; });
  const client = createClient<Database>('https://synthetic-bills.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, patch });
      if (options.overlap) { if (requests.length === 2) release(); await bothEntered; }
      if (options.error || (options.oldSchema && 'due_day' in patch)) return new Response(JSON.stringify({
        code: options.error ?? 'PGRST204', message: options.error ? 'write denied' : "Could not find the 'due_day' column of 'bills' in the schema cache",
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const matches = [...url.searchParams].filter(([key]) => key !== 'select').every(([key, filter]) => {
        const value = row[key as keyof typeof row];
        return filter === 'is.null' ? value === null : filter === `eq.${String(value)}`;
      });
      if (matches) row = { ...row, ...patch, updated_at: '2026-02-01T00:00:00Z' };
      return new Response(JSON.stringify(matches ? [{ id: row.id }] : []), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { client, requests, current: () => row };
}

describe('recurring bill schedule', () => {
  it('keeps the persisted original day through consecutive short-month rolls', () => {
    let row = bill();
    for (const expected of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const patch = billPaidPatch(row, row.due_date);
      expect(patch).toMatchObject({ status: 'upcoming', due_date: expected, due_day: 31 });
      row = { ...row, ...patch };
    }
  });

  it.each([29, 30, 31])('restores day %s after February instead of drifting to the 28th', (day) => {
    const first = billPaidPatch(bill({ due_date: `2026-01-${day}`, due_day: day }), '2026-01-01');
    expect(first).toMatchObject({ due_date: '2026-02-28', due_day: day });
    const next = billPaidPatch(bill({ ...first }), '2026-02-28');
    expect(next).toMatchObject({ due_date: `2026-03-${day}`, due_day: day });
  });

  it('restores a yearly leap day and catches up stale schedules without a walk limit', () => {
    expect(nextBillDueDate('2025-02-28', 'yearly', '2027-03-01', 29)).toBe('2028-02-29');
    expect(nextBillDueDate('2015-01-31', 'monthly', '2026-03-30', 31)).toBe('2026-03-31');
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-03-31', 31)).toBe('2026-04-30');
    expect(nextBillDueDate('1800-01-01', 'weekly', '2026-01-31')).toBe('2026-02-04');
  });

  it.each(['2026-02-28', '2028-02-29', '2026-04-30', '2026-03-28', '2026-03-29', '2026-03-30'])('requires owner confirmation for an ambiguous legacy date %s', (date) => {
    const row = bill({ due_date: date });
    expect(billAnchorDay(row)).toBeNull();
    expect(billPaidPatch(row, date)).toBeNull();
    expect(billPaidPatch(row, date, { cadence: 'monthly', dueDay: 31 })).toMatchObject({ due_day: 31 });
  });

  it('records the owner-selected date for a new bill, even if it is February 28', () => {
    expect(newBillDueDay('2026-02-28', true, 'monthly')).toBe(28);
    expect(newBillDueDay('2026-02-28', true, 'weekly')).toBeNull();
    expect(billAnchorDay(bill({ due_date: '2026-01-31' }))).toBe(31);
  });

  it('lets a new February bill explicitly choose the 31st while keeping its due date valid', () => {
    expect(billDateForAnchorDay('2026-02-28', 31)).toBe('2026-02-28');
    expect(billDateForAnchorDay('2026-01-28', 31)).toBe('2026-01-31');
    expect(billDateForAnchorDay('2026-02-28', 27)).toBe('2026-02-27');
    expect(billPaidPatch(bill({ due_date: '2026-02-28', due_day: 31 }), '2026-02-28')).toMatchObject({ due_date: '2026-03-31', due_day: 31 });
  });

  it('requires a cadence rather than guessing from the recurring flag', () => {
    for (const recurrence of [null, '', 'unknown', 'constructor']) {
      const row = bill({ recurrence });
      expect(billCadence(row)).toBeNull();
      expect(billPaidPatch(row, '2026-01-31')).toBeNull();
      expect(billPaidPatch(row, '2026-01-31', { cadence: 'quarterly', dueDay: 31 })).toMatchObject({ due_date: '2026-04-30', recurrence: 'quarterly', due_day: 31 });
    }
    expect(billCadence(bill({ recurrence: ' Fortnightly ' }))).toBe('biweekly');
    expect(billPaidPatch(bill({ is_recurring: false, recurrence: 'monthly' }), '2026-01-31')).toEqual({ status: 'paid' });
  });

  it('does not mark an invalid recurring schedule permanently paid', () => {
    expect(billPaidPatch(bill({ due_date: '2026-02-30' }), '2026-02-28')).toBeNull();
    expect(nextBillDueDate('2026-01-31', 'monthly', 'invalid', 31)).toBeNull();
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-01-01', 32)).toBeNull();
  });

  it('forecasts the same anchored dates after the stored row has clamped', () => {
    const timeline = buildCashflowTimeline({ bills: [bill({ due_date: '2026-02-28', due_day: 31 })], goals: [], events: [], startingBalance: 1000, now: new Date('2026-02-23T00:00:00Z'), horizonWeeks: 12 });
    expect(timeline.weeks.flatMap((w) => w.moments).map((m) => m.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('refuses a complete forecast for an unknown legacy cadence or month-end anchor', () => {
    for (const row of [bill({ recurrence: null }), bill({ due_date: '2026-02-28' })]) {
      expect(() => buildCashflowTimeline({ bills: [row], goals: [], events: [], startingBalance: 1000, now: new Date('2026-01-26T00:00:00Z') })).toThrow(/Confirm/);
    }
  });
});

describe('bill payment through the actual Supabase query client with synthetic transport', () => {
  it('lets exactly one overlapping payment advance the occurrence', async () => {
    const original = bill();
    const db = store(original, { overlap: true });
    const results = await Promise.all([saveBillPayment(db.client, 'family-1', original, '2026-01-31'), saveBillPayment(db.client, 'family-1', original, '2026-01-31')]);
    expect(results.map((result) => result.data?.length).sort()).toEqual([0, 1]);
    expect(db.current()).toMatchObject({ due_date: '2026-02-28', due_day: 31, status: 'upcoming' });
    expect(db.requests[0].url.searchParams.get('updated_at')).toBe(`eq.${original.updated_at}`);
  });

  it('does not overwrite a newer cadence/anchor edit while due date and status still match', async () => {
    const original = bill();
    const db = store(bill({ recurrence: 'quarterly', due_day: 30, updated_at: '2026-01-02T00:00:00Z' }));
    const result = await saveBillPayment(db.client, 'family-1', original, '2026-01-31');
    expect(result.data).toEqual([]);
    expect(db.current()).toMatchObject({ due_date: '2026-01-31', recurrence: 'quarterly', due_day: 30 });
  });

  it('keeps the family scope on a matching bill id', async () => {
    const original = bill();
    const db = store(bill({ family_id: 'another-family' }));
    expect((await saveBillPayment(db.client, 'family-1', original, '2026-01-31')).data).toEqual([]);
    expect(db.current().due_date).toBe('2026-01-31');
  });

  it('fails closed once on older schema instead of discarding the day and mutating the row', async () => {
    const original = bill();
    const db = store(original, { oldSchema: true });
    const result = await saveBillPayment(db.client, 'family-1', original, '2026-01-31');
    expect(isMissingBillDueDay(result.error)).toBe(true);
    expect(db.requests).toHaveLength(1);
    expect(db.current()).toEqual(original);
  });

  it.each([{ is_recurring: false, recurrence: null }, { is_recurring: true, recurrence: 'weekly' }])('supports a schedule that needs no anchor on older schema', async (over) => {
    const original = bill(over);
    const db = store(original, { oldSchema: true });
    const result = await saveBillPayment(db.client, 'family-1', original, '2026-01-31');
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: original.id }]);
    expect(db.requests[0].patch).not.toHaveProperty('due_day');
  });

  it('saves the explicit owner confirmation in the same conditional payment write', async () => {
    const original = bill({ recurrence: null, due_date: '2026-02-28' });
    const db = store(original);
    expect((await saveBillPayment(db.client, 'family-1', original, '2026-02-28')).error).toBeTruthy();
    expect(db.requests).toHaveLength(0);
    expect((await saveBillPayment(db.client, 'family-1', original, '2026-02-28', { cadence: 'monthly', dueDay: 31 })).error).toBeNull();
    expect(db.current()).toMatchObject({ recurrence: 'monthly', due_day: 31, due_date: '2026-03-31' });
  });

  it('returns a denied write without retrying', async () => {
    const db = store(bill(), { error: '42501' });
    const result = await saveBillPayment(db.client, 'family-1', bill(), '2026-01-31');
    expect(result.error).toMatchObject({ code: '42501' });
    expect(db.requests).toHaveLength(1);
    expect(isMissingBillDueDay({ code: '42501', message: 'due_day denied' })).toBe(false);
  });
});
