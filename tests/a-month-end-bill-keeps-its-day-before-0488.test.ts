import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billPaidPatch, isDueDayNotKept, newBillDueDay, nextBillDueDate, whereBillIsAsSeen, writeBillPatch, type DueDayNotKept } from '@/lib/finance/recurring';
import { buildCashflowTimeline } from '@/lib/finance/timeline';
import { at, bodyOf } from './helpers/source-order';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A MONTH-END BILL PAID ON A DATABASE WITHOUT 0488 KEEPS ITS DAY.
 *
 * 0488 adds `bills.due_day`, the day a month-based bill is anchored on, so a
 * bill due on the 31st rolls to Feb 28 and comes back on Mar 31. Production's
 * ledger stops long before 0488, so the database WITHOUT the column is what
 * production runs. There, `writeBillPatch` used to repeat the write without
 * the column: a Jan 31 bill was stored as Feb 28, nothing could tell it from a
 * 28th bill, it stepped to Mar 28 for ever, and 0488 could not recover the day
 * later (hold 2 on #932, review 5981566086).
 *
 * Now the column is left out only when the due date carries the day anyway,
 * which is every bill except one rolling into a month too short for its day.
 * That one roll is refused, the bill is left exactly as it was, and the person
 * is told why in their language. Nothing is clamped silently; every other bill
 * rolls normally. lib/finance/recurring.ts `writeBillPatch` says why the anchor
 * could not be carried in any column the old table has. (A Mark paid button
 * may instead ask the person whether to move the bill to the shorter day:
 * a-month-end-bill-moves-only-when-asked.test.ts. These calls ask no one.)
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FAMILY = '00000000-0000-4000-8000-00000000fa75';
const MISSING_COLUMN = { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache", details: null, hint: null };

type Bill = Row & { id: string; due_date: string; status: string; is_recurring: boolean; recurrence: string | null; due_day?: number | null };
type Written = { data: unknown; error: unknown };

let n = 0;
const bill = (due_date: string, recurrence: string): Bill => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    family_id: FAMILY, name: `Bill ${n}`, amount: 100, due_date, is_recurring: true, recurrence,
    status: 'upcoming', category: null, autopay: false,
  };
};

/**
 * "Mark paid" exactly as both buttons write it (pinned in
 * a-paid-recurring-bill-comes-due-again.test.ts): the patch, by id and family,
 * compare-and-set on the row the button saw (`whereBillIsAsSeen`). `hasDueDay`
 * false is a database that has not applied 0488: PostgREST refuses any write
 * naming the column (PGRST204) before running it, and every other write lands.
 */
function markPaid(db: ReturnType<typeof createInMemorySupabase>, seen: Bill, today: string, hasDueDay: boolean) {
  const attempts: Row[] = [];
  const result = writeBillPatch(billPaidPatch(seen, today), (p): PromiseLike<Written> => {
    attempts.push({ ...p });
    if (!hasDueDay && 'due_day' in p) return Promise.resolve({ data: null, error: MISSING_COLUMN });
    return whereBillIsAsSeen(db.from('bills').update(p).eq('id', seen.id).eq('family_id', FAMILY), seen).select('id') as PromiseLike<Written>;
  });
  return { attempts, result };
}

const rowOf = (db: ReturnType<typeof createInMemorySupabase>, id: string) => db.table('bills').find((r) => r.id === id) as Bill;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

// [what, due date, cadence, paid on, what happens on a database without 0488]
// `refused` carries the day that would be lost and the date it would have been clamped to.
type Outcome = { rolledTo: string } | { refused: { day: number; wouldBe: string } };
const CASES: [string, string, string, string, Outcome][] = [
  ['Jan 31, monthly, paid Feb 1', '2026-01-31', 'monthly', '2026-02-01', { refused: { day: 31, wouldBe: '2026-02-28' } }],
  ['Jan 31, monthly, paid on its day', '2026-01-31', 'monthly', '2026-01-31', { refused: { day: 31, wouldBe: '2026-02-28' } }],
  ['Jan 30, monthly, into a common February', '2026-01-30', 'monthly', '2026-01-30', { refused: { day: 30, wouldBe: '2026-02-28' } }],
  ['Jan 29, monthly, into a common February', '2026-01-29', 'monthly', '2026-01-29', { refused: { day: 29, wouldBe: '2026-02-28' } }],
  ['Jan 29, monthly, into a leap February: Feb 29 is its own day', '2028-01-29', 'monthly', '2028-01-29', { rolledTo: '2028-02-29' }],
  ['Jan 30, monthly, into a leap February: still one day short', '2028-01-30', 'monthly', '2028-01-30', { refused: { day: 30, wouldBe: '2028-02-29' } }],
  ['a 28th bill into February', '2026-01-28', 'monthly', '2026-01-28', { rolledTo: '2026-02-28' }],
  ['Mar 31, monthly, into April', '2026-03-31', 'monthly', '2026-03-31', { refused: { day: 31, wouldBe: '2026-04-30' } }],
  ['Jul 31, monthly, into August', '2026-07-31', 'monthly', '2026-07-31', { rolledTo: '2026-08-31' }],
  ['Dec 31, monthly, into January', '2026-12-31', 'monthly', '2026-12-31', { rolledTo: '2027-01-31' }],
  ['Jan 31 paid late on Feb 28: the next occurrence still ahead is Mar 31', '2026-01-31', 'monthly', '2026-02-28', { rolledTo: '2026-03-31' }],
  ['Nov 30, quarterly, into February', '2026-11-30', 'quarterly', '2026-11-30', { refused: { day: 30, wouldBe: '2027-02-28' } }],
  ['Feb 29, yearly, into a common year', '2028-02-29', 'yearly', '2028-02-29', { refused: { day: 29, wouldBe: '2029-02-28' } }],
  ['Jan 31, yearly', '2026-01-31', 'yearly', '2026-01-31', { rolledTo: '2027-01-31' }],
  ['Jan 31, weekly: a week step has no day of month to lose', '2026-01-31', 'weekly', '2026-01-31', { rolledTo: '2026-02-07' }],
  ['Jan 30, every two weeks', '2026-01-30', 'biweekly', '2026-01-30', { rolledTo: '2026-02-13' }],
];

describe('Mark paid on a database without 0488 (production today)', () => {
  for (const [what, due, cadence, today, outcome] of CASES) {
    it(what, async () => {
      const db = createInMemorySupabase();
      const seen = bill(due, cadence);
      db.seed('bills', [seen]);
      const before = { ...rowOf(db, seen.id) };
      const { attempts, result } = markPaid(db, seen, today, false);
      const res = await result;

      if ('refused' in outcome) {
        expect(isDueDayNotKept(res.error)).toBe(true);
        const refusal = res.error as DueDayNotKept;
        expect(refusal.day).toBe(outcome.refused.day);
        expect(refusal.dueDate).toBe(outcome.refused.wouldBe);
        expect(res.data).toBeNull();
        // Only the attempt the database refused before running it: no write without the column.
        expect(attempts).toEqual([{ status: 'upcoming', due_date: outcome.refused.wouldBe, due_day: outcome.refused.day }]);
        // The bill is exactly as it was: still due on its own day, still open.
        expect(rowOf(db, seen.id)).toEqual(before);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('0488_a_month_end_bill_keeps_its_day'));
      } else {
        expect(res.error).toBeNull();
        expect(res.data).toEqual([{ id: seen.id }]);
        expect(rowOf(db, seen.id)).toMatchObject({ due_date: outcome.rolledTo, status: 'upcoming' });
        // The old table has no such column, and nothing invented one.
        expect(rowOf(db, seen.id)).not.toHaveProperty('due_day');
        if (cadence === 'weekly' || cadence === 'biweekly') {
          // A week step never names the column, so the old table takes it at once.
          expect(attempts).toHaveLength(1);
        } else {
          // A month step names it once, is refused, and is written without it, because
          // the date it landed on IS its day: stepping from that date loses nothing next time.
          expect(attempts).toHaveLength(2);
          expect(Number(outcome.rolledTo.slice(8)), 'lands on its own day').toBe(Number(due.slice(8)));
        }
      }
    });
  }

  it('in one household, only the bills a short month would cut are held back; every other bill rolls', async () => {
    const db = createInMemorySupabase();
    const bills = CASES.map(([, due, cadence]) => bill(due, cadence));
    db.seed('bills', bills);
    await Promise.all(bills.map((b, i) => markPaid(db, b, CASES[i][3], false).result));
    CASES.forEach(([what, due, , , outcome], i) => {
      const row = rowOf(db, bills[i].id);
      if ('refused' in outcome) expect(row.due_date, what).toBe(due);
      else expect(row.due_date, what).toBe(outcome.rolledTo);
    });
  });

  it('the refused bill rolls with its day kept once 0488 is applied: Feb 28, then Mar 31', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31', 'monthly');
    db.seed('bills', [rent]);
    expect(isDueDayNotKept((await markPaid(db, rent, '2026-02-01', false).result).error)).toBe(true);

    // 0488 applied: the same click on the same, untouched row.
    await markPaid(db, { ...rowOf(db, rent.id) }, '2026-02-01', true).result;
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-02-28', due_day: 31 });
    await markPaid(db, { ...rowOf(db, rent.id) }, '2026-03-01', true).result;
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-03-31', due_day: 31 });
  });

  it('while it is held back the forecast still keeps the day: Jan 31 forecasts Feb 28 and Mar 31 without the column', () => {
    const NOW = new Date('2026-01-15T12:00:00.000Z');
    const moments = buildCashflowTimeline({
      bills: [{ name: 'Rent', amount: 100, due_date: '2026-01-31', status: 'upcoming', category: null, is_recurring: true, recurrence: 'monthly' }],
      goals: [], events: [], startingBalance: 1000, now: NOW,
    }).weeks.flatMap((w) => w.moments).filter((m) => m.label === 'Rent').map((m) => m.date);
    expect(moments).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('a new month-end bill is added without the column: its due date is its day', async () => {
    const db = createInMemorySupabase();
    const attempts: Row[] = [];
    const row = { family_id: FAMILY, name: 'Rent', amount: 100, due_date: '2026-01-31', due_day: newBillDueDay('2026-01-31', true, 'monthly'), is_recurring: true, recurrence: 'monthly', status: 'upcoming' as const };
    const res = await writeBillPatch(row, (p): PromiseLike<Written> => {
      attempts.push({ ...p });
      if ('due_day' in p) return Promise.resolve({ data: null, error: MISSING_COLUMN });
      return db.from('bills').insert(p) as PromiseLike<Written>;
    });
    expect(res.error).toBeNull();
    expect(attempts.map((a) => 'due_day' in a)).toEqual([true, false]);
    expect(db.table('bills')).toEqual([expect.objectContaining({ due_date: '2026-01-31' })]);
  });
});

describe('the same clicks with 0488 applied are unchanged', () => {
  for (const [what, due, cadence, today] of CASES) {
    it(what, async () => {
      const db = createInMemorySupabase();
      const seen = bill(due, cadence);
      db.seed('bills', [seen]);
      const { attempts, result } = markPaid(db, seen, today, true);
      const res = await result;
      expect(res.error).toBeNull();
      expect(attempts).toHaveLength(1);
      const monthBased = cadence !== 'weekly' && cadence !== 'biweekly';
      const expected = nextBillDueDate(due, cadence as Parameters<typeof nextBillDueDate>[1], today, monthBased ? Number(due.slice(8)) : null);
      expect(rowOf(db, seen.id)).toMatchObject(monthBased
        ? { due_date: expected, due_day: Number(due.slice(8)), status: 'upcoming' }
        : { due_date: expected, status: 'upcoming' });
      expect(warn).not.toHaveBeenCalled();
    });
  }
});

describe('the person is told, in their language', () => {
  it('both Mark paid buttons answer the refusal with its own message before any other error', () => {
    const view = read('components/finance/bills-view.tsx');
    const markPaidBody = bodyOf(view, 'async function markPaid(b: Bill) {', "success(reopen ? 'Reopened' : 'Marked paid');");
    const viewRefusal = "if (isDueDayNotKept(error)) { toastError(t('bills.dueDayNeedsDatabaseUpdate', { day: error.day })); return; }";
    expect(markPaidBody).toContain(viewRefusal);
    expect(at(markPaidBody, viewRefusal)).toBeLessThan(at(markPaidBody, 'if (error) { toastError(describeDbError(error)); return; }'));

    const module_ = read('components/modules/billing-module.tsx');
    const markBillPaidBody = bodyOf(module_, 'async function markBillPaid(id: string) {', "success(tr('billingModule.billMarkedAsPaid'));");
    const moduleRefusal = "if (isDueDayNotKept(error)) return toastError(tr('bills.dueDayNeedsDatabaseUpdate', { day: error.day }));";
    expect(markBillPaidBody).toContain(moduleRefusal);
    expect(at(markBillPaidBody, moduleRefusal)).toBeLessThan(at(markBillPaidBody, 'if (error) return toastError(describeDbError(error));'));
  });

  it('the message is in English and every base catalogue, names the day, and says the bill was left as it was', () => {
    const en = JSON.parse(read('lib/i18n/messages/en-US.json')) as Record<string, string>;
    expect(en['bills.dueDayNeedsDatabaseUpdate']).toBe("This bill is due on day {day} of each month, and the next month is shorter. That day can't be kept until a database update is applied, so the bill was left as it was and not marked paid.");
    for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      const text = messages['bills.dueDayNeedsDatabaseUpdate'];
      expect(text, locale).toContain('{day}');
      expect(text, `${locale} is translated`).not.toBe(en['bills.dueDayNeedsDatabaseUpdate']);
    }
  });
});
