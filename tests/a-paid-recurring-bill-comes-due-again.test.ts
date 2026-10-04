import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { billAnchorDay, billCadence, billPaidPatch, isMissingDueDayColumn, MONTH_BASED_CADENCES, newBillDueDay, nextBillDueDate, writeBillPatch } from '@/lib/finance/hub';
import { buildCashflowTimeline } from '@/lib/finance/timeline';
import { bodyOf } from './helpers/source-order';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { wroteNoRows } from '@/lib/supabase/errors';

/**
 * A RECURRING BILL, MARKED PAID, NEVER CAME DUE AGAIN.
 *
 * A bill is one row: `due_date`, `status`, and for a recurring one
 * `is_recurring` + `recurrence`. Both "Mark paid" buttons (the Bill Manager,
 * components/finance/bills-view.tsx; the Billing module,
 * components/modules/billing-module.tsx) wrote `status: 'paid'` and nothing
 * else — so a monthly bill, once paid, sat on its old due date as `paid` for
 * ever. Every "due soon" reader (the brief, the briefing API, the operating
 * index, readiness, the Due Reminders tab, the Finances card) selects
 * `status <> 'paid'`, so the household was reminded of the bill exactly once.
 * The forecast (lib/finance/timeline.ts) disagreed with all of them: it keeps
 * a paid recurring bill's later occurrences, so the money showed in the
 * projection and nowhere else.
 *
 * The fix is one pure decision, `billPaidPatch`, that both buttons write: a
 * one-off is paid; a recurring bill rolls to its next due date and stays
 * open. The Bill Manager's add form, which flagged a bill recurring without
 * ever recording a cadence, now records one.
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('billCadence', () => {
  it('reads the recorded cadence, with the forecast\'s aliases', () => {
    expect(billCadence({ is_recurring: true, recurrence: 'monthly' })).toBe('monthly');
    expect(billCadence({ is_recurring: true, recurrence: 'Quarterly' })).toBe('quarterly');
    expect(billCadence({ is_recurring: true, recurrence: 'fortnightly' })).toBe('biweekly');
    expect(billCadence({ is_recurring: true, recurrence: 'annually' })).toBe('yearly');
  });
  it('a one-off has none, and a recorded cadence on an unflagged row still counts', () => {
    expect(billCadence({ is_recurring: false, recurrence: null })).toBeNull();
    expect(billCadence({ is_recurring: null, recurrence: null })).toBeNull();
    expect(billCadence({ is_recurring: false, recurrence: 'weekly' })).toBe('weekly');
  });
  it('a bill flagged recurring with no cadence — what the Bill Manager wrote — reads as monthly', () => {
    expect(billCadence({ is_recurring: true, recurrence: null })).toBe('monthly');
    expect(billCadence({ is_recurring: true, recurrence: '' })).toBe('monthly');
  });
});

describe('nextBillDueDate', () => {
  it('rolls a monthly bill to next month once it is paid', () => {
    expect(nextBillDueDate('2026-10-01', 'monthly', '2026-10-03')).toBe('2026-11-01');
  });
  it('keeps the series anchor when a bill is paid early', () => {
    expect(nextBillDueDate('2026-10-15', 'monthly', '2026-10-03')).toBe('2026-11-15');
    expect(nextBillDueDate('2026-10-15', 'monthly', '2026-10-15'), 'paid on the day').toBe('2026-11-15');
  });
  it('a stale bill marked paid lands on the first occurrence still ahead, not on every month in between', () => {
    expect(nextBillDueDate('2026-03-01', 'monthly', '2026-10-03')).toBe('2026-11-01');
    expect(nextBillDueDate('2025-10-03', 'yearly', '2026-10-03'), 'due today a year on').toBe('2027-10-03');
  });
  it('clamps a month-end anchor to a short month and comes back to it — from the PERSISTED clamped date, by the anchor day (audit 2026-10-04 07:45)', () => {
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-02-01')).toBe('2026-02-28');
    // The row now HOLDS Feb 28. Stepped from that date's own day it would come
    // back on the 28th for ever (the audit's finding: the old test handed the
    // original anchor back in); stepped by the anchor day it is Mar 31 again.
    expect(nextBillDueDate('2026-02-28', 'monthly', '2026-02-28')).toBe('2026-03-28');
    expect(nextBillDueDate('2026-02-28', 'monthly', '2026-02-28', 31)).toBe('2026-03-31');
    expect(nextBillDueDate('2026-03-31', 'monthly', '2026-04-01', 31)).toBe('2026-04-30');
    expect(nextBillDueDate('2026-04-30', 'monthly', '2026-05-01', 31)).toBe('2026-05-31');
    // A 30th bill stays a 30th bill through February.
    expect(nextBillDueDate('2026-02-28', 'monthly', '2026-03-01', 30)).toBe('2026-03-30');
    expect(nextBillDueDate('2026-11-30', 'quarterly', '2026-12-01')).toBe('2027-02-28');
    expect(nextBillDueDate('2027-02-28', 'quarterly', '2027-03-01', 30)).toBe('2027-05-30');
    expect(nextBillDueDate('2024-02-29', 'yearly', '2024-03-01')).toBe('2025-02-28');
    expect(nextBillDueDate('2025-02-28', 'yearly', '2025-03-01', 29), 'back on the 29th in the next leap year').toBe('2026-02-28');
    expect(nextBillDueDate('2027-02-28', 'yearly', '2027-03-01', 29)).toBe('2028-02-29');
    // A week step counts days from the date itself; the anchor day is a month-based notion.
    expect(nextBillDueDate('2026-10-02', 'weekly', '2026-10-03', 31)).toBe('2026-10-09');
    // A day that is not one is ignored.
    expect(nextBillDueDate('2026-02-28', 'monthly', '2026-03-01', 0)).toBe('2026-03-28');
    expect(nextBillDueDate('2026-02-28', 'monthly', '2026-03-01', 32)).toBe('2026-03-28');
  });
  it('steps weekly and biweekly bills by days', () => {
    expect(nextBillDueDate('2026-10-02', 'weekly', '2026-10-03')).toBe('2026-10-09');
    expect(nextBillDueDate('2026-10-02', 'biweekly', '2026-10-03')).toBe('2026-10-16');
    expect(nextBillDueDate('2026-01-02', 'weekly', '2026-10-03'), 'a stale weekly bill').toBe('2026-10-09');
  });
  it('refuses a due date that is not a calendar day, and ignores a malformed today', () => {
    expect(nextBillDueDate('2026-02-30', 'monthly', '2026-10-03')).toBeNull();
    expect(nextBillDueDate('soon', 'monthly', '2026-10-03')).toBeNull();
    expect(nextBillDueDate('2026-10-01', 'monthly', 'today')).toBe('2026-11-01');
  });
});

describe('billAnchorDay and newBillDueDay (0488)', () => {
  it('the recorded day wins; without one the due date\'s day is the anchor', () => {
    expect(billAnchorDay({ due_date: '2026-02-28', due_day: 31 })).toBe(31);
    expect(billAnchorDay({ due_date: '2026-02-28', due_day: null })).toBe(28);
    expect(billAnchorDay({ due_date: '2026-02-28' })).toBe(28);
    expect(billAnchorDay({ due_date: 'soon', due_day: null })).toBeNull();
    expect(billAnchorDay({ due_date: '2026-02-28', due_day: 40 }), 'an impossible day is ignored').toBe(28);
  });
  it('a new month-based recurring bill records the day of its due date; a weekly one or a one-off records nothing', () => {
    expect(newBillDueDay('2026-01-31', true, 'monthly')).toBe(31);
    expect(newBillDueDay('2026-01-31', true, 'quarterly')).toBe(31);
    expect(newBillDueDay('2026-01-31', true, null), 'flagged recurring with no cadence reads as monthly').toBe(31);
    expect(newBillDueDay('2026-01-31', true, 'weekly')).toBeNull();
    expect(newBillDueDay('2026-01-31', false, 'monthly')).toBeNull();
    expect(newBillDueDay('not a day', true, 'monthly')).toBeNull();
    expect([...MONTH_BASED_CADENCES].sort()).toEqual(['monthly', 'quarterly', 'yearly']);
  });
});

describe('billPaidPatch — what "Mark paid" writes', () => {
  const today = '2026-10-03';
  it('a one-off is paid and stays paid', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'upcoming', is_recurring: false, recurrence: null }, today)).toEqual({ status: 'paid' });
  });
  it('a recurring bill rolls to its next due date and stays open', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'overdue', is_recurring: true, recurrence: 'monthly' }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-11-01', due_day: 1 });
    expect(billPaidPatch({ due_date: '2026-10-02', status: 'upcoming', is_recurring: true, recurrence: 'weekly' }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-10-09' });
  });
  it('a bill the Bill Manager flagged recurring without a cadence rolls monthly rather than closing', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'upcoming', is_recurring: true, recurrence: null }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-11-01', due_day: 1 });
  });
  it('a recurring bill whose due date is not a day falls back to paid rather than throwing', () => {
    expect(billPaidPatch({ due_date: 'soon', status: 'upcoming', is_recurring: true, recurrence: 'monthly' }, today)).toEqual({ status: 'paid' });
  });

  it('a month-based bill writes the anchor day the first time it rolls, so the day survives the clamp (audit 2026-10-04 07:45)', () => {
    // Jan 31 paid on Feb 1: the row goes to Feb 28 AND remembers 31.
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-01-31', is_recurring: true, recurrence: 'monthly' }, '2026-02-01'))
      .toEqual({ status: 'upcoming', due_date: '2026-02-28', due_day: 31 });
    // The persisted row, paid on Mar 1: back on the 31st, still remembering it.
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-02-28', due_day: 31, is_recurring: true, recurrence: 'monthly' }, '2026-03-01'))
      .toEqual({ status: 'upcoming', due_date: '2026-03-31', due_day: 31 });
    // A row from before 0488 that already sits on Feb 28 knows only the 28th: that is recorded, and stepped by.
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-02-28', is_recurring: true, recurrence: 'monthly' }, '2026-03-01'))
      .toEqual({ status: 'upcoming', due_date: '2026-03-28', due_day: 28 });
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-11-30', is_recurring: true, recurrence: 'quarterly' }, '2026-12-01'))
      .toEqual({ status: 'upcoming', due_date: '2027-02-28', due_day: 30 });
  });
  it('a weekly bill carries no anchor day, and a one-off none at all', () => {
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-10-02', is_recurring: true, recurrence: 'weekly' }, '2026-10-03'))
      .toEqual({ status: 'upcoming', due_date: '2026-10-09' });
    expect(billPaidPatch({ status: 'upcoming', due_date: '2026-10-02', is_recurring: false, recurrence: null }, '2026-10-03')).toEqual({ status: 'paid' });
  });
});

describe('writeBillPatch — a database that has not applied 0488', () => {
  const missing = { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" };
  const writes = (answers: { error: unknown }[]) => {
    const seen: unknown[] = [];
    const write = async (p: unknown) => { seen.push(p); return answers[seen.length - 1] ?? { error: null }; };
    return { seen, write };
  };
  it('names the column the database lacks, and nothing else', () => {
    expect(isMissingDueDayColumn(missing)).toBe(true);
    expect(isMissingDueDayColumn({ code: '42703', message: 'column "due_day" of relation "bills" does not exist' })).toBe(true);
    expect(isMissingDueDayColumn({ code: 'PGRST204', message: "Could not find the 'autopay' column" })).toBe(false);
    expect(isMissingDueDayColumn({ code: '23514', message: 'violates check constraint bills_due_day_check' })).toBe(false);
    expect(isMissingDueDayColumn(null)).toBe(false);
  });
  it('writes once when the column is there, and once more without it when it is not', async () => {
    const ok = writes([{ error: null }]);
    expect(await writeBillPatch({ status: 'upcoming', due_date: '2026-02-28', due_day: 31 }, ok.write)).toEqual({ error: null });
    expect(ok.seen).toEqual([{ status: 'upcoming', due_date: '2026-02-28', due_day: 31 }]);

    const behind = writes([{ error: missing }, { error: null }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await writeBillPatch({ status: 'upcoming', due_date: '2026-02-28', due_day: 31 }, behind.write)).toEqual({ error: null });
    expect(behind.seen, 'the same row, without the one column').toEqual([{ status: 'upcoming', due_date: '2026-02-28', due_day: 31 }, { status: 'upcoming', due_date: '2026-02-28' }]);
    // What that database cannot keep is said, not papered over (review 5981566086):
    // the row lands on the 28th with nowhere to record the 31, and once 0488
    // arrives it records 28 — the case `billPaidPatch` pins above as "a pre-0488
    // row records the day of its current due date, which is all it knows".
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/LOSES its original day.*0488 has no backfill/));
    warn.mockRestore();
  });
  it('does not retry any other refusal, nor a write that never carried the column', async () => {
    const refused = { error: { code: '42501', message: 'permission denied' } };
    const other = writes([refused, { error: null }]);
    expect(await writeBillPatch({ status: 'upcoming', due_date: '2026-02-28', due_day: 31 }, other.write)).toEqual(refused);
    expect(other.seen).toHaveLength(1);
    const plain = writes([{ error: missing }, { error: null }]);
    expect(await writeBillPatch({ status: 'paid' }, plain.write)).toEqual({ error: missing });
    expect(plain.seen).toHaveLength(1);
  });
});

describe('two "Mark paid" clicks on one stale row roll the bill once (review 5981518473)', () => {
  // Both buttons write exactly this (pinned below): the patch, by id and
  // family, AND by the due date and status the button saw. The first click
  // lands; the second, carrying the same stale snapshot, matches no row and is
  // told "that change was not saved" instead of rolling the bill a second month.
  const FAMILY = '00000000-0000-4000-8000-00000000fa88';
  const BILL = '00000000-0000-4000-8000-00000000b188';
  const snapshot = { id: BILL, family_id: FAMILY, name: 'Rent', amount: 1000, due_date: '2026-01-31', due_day: null, is_recurring: true, recurrence: 'monthly', status: 'upcoming' as const, category: null, autopay: false };
  const markPaid = (db: ReturnType<typeof createInMemorySupabase>, seen: typeof snapshot) =>
    writeBillPatch(billPaidPatch(seen, '2026-01-31'), (p) => db.from('bills').update(p).eq('id', seen.id).eq('family_id', FAMILY).eq('due_date', seen.due_date).eq('status', seen.status).select('id'));

  it('the first click rolls Jan 31 to Feb 28 with its anchor; the second, on the same snapshot, writes nothing', async () => {
    const db = createInMemorySupabase();
    db.seed('bills', [snapshot]);
    const [first, second] = await Promise.all([markPaid(db, snapshot), markPaid(db, snapshot)]);
    const outcomes = [first, second].map((r) => (r.error ? 'error' : wroteNoRows(r.data as unknown[] | null) ? 'no-row' : 'written')).sort();
    expect(outcomes).toEqual(['no-row', 'written']);
    expect(db.table('bills')[0]).toMatchObject({ due_date: '2026-02-28', due_day: 31, status: 'upcoming' });
  });

  it('a click on the row as it now is rolls it on: the compare-and-set admits a fresh snapshot', async () => {
    const db = createInMemorySupabase();
    db.seed('bills', [snapshot]);
    await markPaid(db, snapshot);
    const fresh = db.table('bills')[0] as typeof snapshot;
    const res = await writeBillPatch(billPaidPatch(fresh, '2026-02-28'), (p) => db.from('bills').update(p).eq('id', fresh.id).eq('family_id', FAMILY).eq('due_date', fresh.due_date).eq('status', fresh.status).select('id'));
    expect(wroteNoRows(res.data as unknown[] | null)).toBe(false);
    expect(db.table('bills')[0]).toMatchObject({ due_date: '2026-03-31', due_day: 31 });
  });
});

describe('the forecast steps a month-end bill the same way (lib/finance/timeline.ts)', () => {
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const dates = (bill: Record<string, unknown>) => buildCashflowTimeline({
    bills: [{ name: 'Card', amount: 100, status: 'upcoming', category: null, is_recurring: true, recurrence: 'monthly', ...bill } as never],
    goals: [], events: [], startingBalance: 1000, now: NOW,
  }).weeks.flatMap((w) => w.moments).filter((m) => m.label === 'Card').map((m) => m.date);
  it('a bill due on the 31st forecasts Feb 28 and Mar 31 — not Mar 3, and not the 28th thereafter', () => {
    expect(dates({ due_date: '2026-01-31' })).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('the persisted clamped row with its anchor day forecasts the same series', () => {
    expect(dates({ due_date: '2026-02-28', due_day: 31 })).toEqual(['2026-02-28', '2026-03-31']);
    expect(dates({ due_date: '2026-02-28' }), 'without the anchor day: the 28th, as the list would say').toEqual(['2026-02-28', '2026-03-28']);
  });
});

describe('0488 and its writers', () => {
  it('the migration adds one nullable, checked column and nothing else', () => {
    const sql = read('supabase/migrations/0488_a_month_end_bill_keeps_its_day.sql');
    expect(sql).toContain('alter table public.bills add column if not exists due_day smallint');
    expect(sql).toContain('check (due_day between 1 and 31)');
    expect(sql).toMatch(/comment on column public\.bills\.due_day/);
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/create (unique )?index|create policy|create (or replace )?function|update public\.bills|default/i);
    expect(read('lib/database.types.ts')).toContain('due_date: string; due_day: number | null; is_recurring: boolean;');
  });
  it('both Mark paid buttons and both add forms write through the fallback, and the forms record the anchor day', () => {
    const view = read('components/finance/bills-view.tsx');
    expect(view).toContain("await writeBillPatch(patch, (p) => createClient().from('bills').update(p).eq('id', b.id).eq('family_id', familyId).eq('due_date', b.due_date).eq('status', b.status).select('id'))");
    expect(view).toContain('due_day: newBillDueDay(v.due_date, v.is_recurring, v.recurrence),');
    expect(view).toContain("}, (p) => createClient().from('bills').insert(p));");
    const module_ = read('components/modules/billing-module.tsx');
    expect(module_).toContain("const q = supabase.from('bills').update(p).eq('id', id).eq('family_id', familyId);");
    expect(module_).toContain("return (bill ? q.eq('due_date', bill.due_date).eq('status', bill.status) : q).select('id');");
    expect(module_).toContain('due_day: newBillDueDay(dueDate, isRecurring, recurrence),');
    expect(module_).toContain("}, (p) => supabase.from('bills').insert(p));");
  });
});

describe('both Mark paid buttons write the patch, in the family\'s day', () => {
  it('the Bill Manager', () => {
    const src = read('components/finance/bills-view.tsx');
    expect(src).toContain("import { useFamilyCalendarToday, useFamilyClock } from '@/components/i18n/use-format';");
    const body = bodyOf(src, 'async function markPaid(b: Bill) {', "success(reopen ? 'Reopened' : 'Marked paid');");
    expect(body).toContain('billPaidPatch(b, clock.todayKey())');
    expect(body).toContain('writeBillPatch(patch, (p) =>');
    expect(body).toContain('.update(p)');
    expect(body, 'the old flat write is gone').not.toContain("update({ status: next })");
    // Reopening a one-off is still a plain status flip.
    expect(body).toContain("reopen ? { status: 'upcoming' as const } : billPaidPatch");
  });
  it('the Billing module', () => {
    const src = read('components/modules/billing-module.tsx');
    expect(src).toContain("import { billPaidPatch, newBillDueDay, writeBillPatch } from '@/lib/finance/hub';");
    const body = bodyOf(src, 'async function markBillPaid(id: string) {', "success(tr('billingModule.billMarkedAsPaid'));");
    expect(body).toContain('billPaidPatch(bill, clock.todayKey())');
    expect(body).toContain('writeBillPatch(patch, (p) =>');
    expect(body).toContain('.update(p)');
    expect(body).not.toContain("update({ status: 'paid' })");
  });
  it('the Bill Manager\'s add form records a cadence for a recurring bill', () => {
    const src = read('components/finance/bills-view.tsx');
    const modal = bodyOf(src, 'function BillModal(', "success(t('billsView.billAdded'));");
    expect(modal).toContain("recurrence: v.is_recurring ? v.recurrence : null");
    expect(modal).toContain("recurrence: 'monthly'");
    // The same five cadences the Billing module offers, under the same keys.
    for (const cadence of ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
      expect(src).toContain(`<option value="${cadence}">{t('billing.${cadence}')}</option>`);
    }
  });
});
