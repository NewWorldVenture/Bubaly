import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billPaidPatch, dueDayNotKeptQuestion, isDueDayNotKept, writeBillPatch, type DueDayNotKept } from '@/lib/finance/recurring';
import { bodyOf } from './helpers/source-order';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { wroteNoRows } from '@/lib/supabase/errors';

/**
 * A MONTH-END BILL MOVES TO A SHORTER DAY ONLY WHEN THE PERSON SAYS SO.
 *
 * Production runs without 0475's `bills.due_day`, and there a bill due on the
 * 31st that rolls into February can be stored only as Feb 28, which nothing
 * can later tell from a 28th bill. `writeBillPatch` refuses that roll rather
 * than clamp it silently (a-month-end-bill-keeps-its-day-before-0475.test.ts).
 * Refusal alone would mean a 31st bill cannot be marked paid in five months of
 * every twelve, so the two Mark paid buttons ASK: "mark it paid and move it to
 * Feb 28, due on the 28th from now on?" Confirmed, the bill is written on the
 * clamped date without `due_day`, the person having chosen the new day.
 * Declined, nothing is written and the refusal is shown. A caller with no one
 * to ask (a server path, an AI tool, the autopilot) still only refuses.
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FAMILY = '00000000-0000-4000-8000-00000000fb75';
const MISSING_COLUMN = { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache", details: null, hint: null };

type Bill = Row & { id: string; due_date: string; status: string; is_recurring: boolean; recurrence: string | null; due_day?: number | null };
type Written = { data: unknown; error: unknown };
type Db = ReturnType<typeof createInMemorySupabase>;

let n = 0;
const bill = (due_date: string, recurrence = 'monthly'): Bill => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    family_id: FAMILY, name: `Rent ${n}`, amount: 100, due_date, is_recurring: true, recurrence,
    status: 'upcoming', category: null, autopay: false,
  };
};

/**
 * "Mark paid" as both buttons write it: the patch, by id and family,
 * compare-and-set on the due date and status the button saw. `hasDueDay`
 * false is production's database. `answer`, when given, is the person's reply
 * to the question; absent, there is no one to ask.
 */
function markPaid(db: Db, seen: Bill, today: string, hasDueDay: boolean, answer?: (refusal: DueDayNotKept) => Promise<boolean>) {
  const attempts: Row[] = [];
  const asked: DueDayNotKept[] = [];
  const options = answer ? { confirmClampedDay: (refusal: DueDayNotKept) => { asked.push(refusal); return answer(refusal); } } : undefined;
  const result = writeBillPatch(billPaidPatch(seen, today), (p): PromiseLike<Written> => {
    attempts.push({ ...p });
    if (!hasDueDay && 'due_day' in p) return Promise.resolve({ data: null, error: MISSING_COLUMN });
    return db.from('bills').update(p).eq('id', seen.id).eq('family_id', FAMILY).eq('due_date', seen.due_date).eq('status', seen.status).select('id') as PromiseLike<Written>;
  }, options);
  return { attempts, asked, result };
}

const yes = async () => true;
const no = async () => false;
const rowOf = (db: Db, id: string) => db.table('bills').find((r) => r.id === id) as Bill;
const outcome = (r: { data: unknown; error: unknown }) => (r.error ? (isDueDayNotKept(r.error) ? 'refused' : 'error') : wroteNoRows(r.data as unknown[] | null) ? 'no-row' : 'written');

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe('on a database without 0475, the person is asked before a month-end bill moves', () => {
  it('confirmed: Jan 31 is marked paid on Feb 28, written once, with no due_day, and is a 28th bill from then on', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const { attempts, asked, result } = markPaid(db, rent, '2026-02-01', false, yes);
    const res = await result;

    expect(asked).toEqual([expect.objectContaining({ day: 31, dueDate: '2026-02-28' })]);
    // The refused attempt (the column is not there), then the one write the person chose.
    expect(attempts).toEqual([
      { status: 'upcoming', due_date: '2026-02-28', due_day: 31 },
      { status: 'upcoming', due_date: '2026-02-28' },
    ]);
    expect(outcome(res)).toBe('written');
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-02-28', status: 'upcoming' });
    expect(rowOf(db, rent.id)).not.toHaveProperty('due_day');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0475_a_month_end_bill_keeps_its_day.*chose.*2026-02-28/));

    // The day the person chose is the day it keeps: Mar 28, and nothing is asked again.
    const next = markPaid(db, { ...rowOf(db, rent.id) }, '2026-03-01', false, yes);
    expect(outcome(await next.result)).toBe('written');
    expect(next.asked).toEqual([]);
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-03-28' });
  });

  it('declined: nothing is written, and the refusal comes back for the button to show', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const before = { ...rowOf(db, rent.id) };
    const { attempts, asked, result } = markPaid(db, rent, '2026-02-01', false, no);
    const res = await result;

    expect(asked).toHaveLength(1);
    expect(attempts, 'only the attempt the database refused before running it').toHaveLength(1);
    expect(outcome(res)).toBe('refused');
    expect(res.error).toMatchObject({ day: 31, dueDate: '2026-02-28' });
    expect(rowOf(db, rent.id)).toEqual(before);
  });

  it('the same question for every clamped roll: Jan 30 into a common February, Jan 30 into a leap one, a 29 Feb yearly bill, a Nov 30 quarterly bill', async () => {
    const cases: [string, string, string, number, string][] = [
      ['2026-01-30', 'monthly', '2026-01-30', 30, '2026-02-28'],
      ['2028-01-30', 'monthly', '2028-01-30', 30, '2028-02-29'],
      ['2028-02-29', 'yearly', '2028-02-29', 29, '2029-02-28'],
      ['2026-11-30', 'quarterly', '2026-11-30', 30, '2027-02-28'],
      ['2026-03-31', 'monthly', '2026-03-31', 31, '2026-04-30'],
    ];
    for (const [due, cadence, today, day, clamped] of cases) {
      const db = createInMemorySupabase();
      const b = bill(due, cadence);
      db.seed('bills', [b]);
      const { asked, result } = markPaid(db, b, today, false, yes);
      expect(outcome(await result), due).toBe('written');
      expect(asked, due).toEqual([expect.objectContaining({ day, dueDate: clamped })]);
      expect(rowOf(db, b.id).due_date, due).toBe(clamped);
    }
  });

  it('a roll that keeps its day is never asked about: Jan 29 into a leap February, a 28th bill, Jul 31 into August, weekly', async () => {
    for (const [due, cadence, today, to] of [
      ['2028-01-29', 'monthly', '2028-01-29', '2028-02-29'],
      ['2026-01-28', 'monthly', '2026-01-28', '2026-02-28'],
      ['2026-07-31', 'monthly', '2026-07-31', '2026-08-31'],
      ['2026-01-31', 'weekly', '2026-01-31', '2026-02-07'],
    ] as const) {
      const db = createInMemorySupabase();
      const b = bill(due, cadence);
      db.seed('bills', [b]);
      const { asked, result } = markPaid(db, b, today, false, async () => { throw new Error('asked about a roll that loses nothing'); });
      expect(outcome(await result), due).toBe('written');
      expect(asked, due).toEqual([]);
      expect(rowOf(db, b.id).due_date, due).toBe(to);
    }
  });

  it('a confirmed move is still a compare-and-set: two clicks on one snapshot move it once', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const snapshot = { ...rent };
    const [a, b] = await Promise.all([markPaid(db, snapshot, '2026-02-01', false, yes).result, markPaid(db, snapshot, '2026-02-01', false, yes).result]);
    expect([outcome(a), outcome(b)].sort()).toEqual(['no-row', 'written']);
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-02-28' });
  });

  it('a bill that moved while the question was open is not moved again: the confirmed write matches no row', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const snapshot = { ...rent };
    // Someone else marks it paid (and moves it) while this person reads the question.
    const { result } = markPaid(db, snapshot, '2026-02-01', false, async () => {
      Object.assign(rowOf(db, rent.id), { due_date: '2026-02-28' });
      return true;
    });
    expect(outcome(await result)).toBe('no-row');
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-02-28' });
  });

  it('with no one to ask (a server path, an AI tool, the autopilot) it only refuses', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const before = { ...rowOf(db, rent.id) };
    const { attempts, result } = markPaid(db, rent, '2026-02-01', false);
    expect(outcome(await result)).toBe('refused');
    expect(attempts).toHaveLength(1);
    expect(rowOf(db, rent.id)).toEqual(before);
  });

  it('with 0475 applied nobody is asked: the roll keeps the 31st', async () => {
    const db = createInMemorySupabase();
    const rent = bill('2026-01-31');
    db.seed('bills', [rent]);
    const { attempts, asked, result } = markPaid(db, rent, '2026-02-01', true, async () => { throw new Error('asked with the column present'); });
    expect(outcome(await result)).toBe('written');
    expect(asked).toEqual([]);
    expect(attempts).toHaveLength(1);
    expect(rowOf(db, rent.id)).toMatchObject({ due_date: '2026-02-28', due_day: 31 });
  });
});

describe('the question, in the reader\'s language', () => {
  const catalogue = (locale: string) => JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
  const translator = (locale: string) => {
    const messages = catalogue(locale);
    return (key: string, params?: Record<string, string | number>) =>
      (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));
  };
  const refusal = (day: number, dueDate: string): DueDayNotKept => ({ code: 'BUBALY_DUE_DAY_NOT_KEPT', message: '', day, dueDate });

  it('names the day, the short month, the date it moves to and the day it keeps, and is not painted as a delete', () => {
    const q = dueDayNotKeptQuestion(refusal(31, '2026-02-28'), translator('en-US'), (key) => `<${key}>`, 'en-US');
    expect(q.title).toBe('Mark paid and move this bill to <2026-02-28>?');
    expect(q.body).toBe("This bill is due on day 31 of each month, but February has no day 31. Until a database update is applied, Bubaly can't remember day 31, so from now on it will be due on day 28.");
    expect(q.confirmLabel).toBe('Mark paid and move it');
    expect(q.cancelLabel).toBe('Leave it unchanged');
    expect(q.destructive).toBe(false);
  });

  it('a 30th bill in a leap February keeps the 29th; the month is the reader\'s word for it', () => {
    const en = dueDayNotKeptQuestion(refusal(30, '2028-02-29'), translator('en-US'), (key) => key, 'en-US');
    expect(en.body).toContain('February has no day 30');
    expect(en.body).toContain('due on day 29');
    const de = dueDayNotKeptQuestion(refusal(31, '2026-04-30'), translator('de-DE'), (key) => key, 'de-DE');
    expect(de.body).toContain('April');
    expect(de.body).toContain('31.');
    expect(de.body).toContain('30.');
    const fr = dueDayNotKeptQuestion(refusal(31, '2026-02-28'), translator('fr-FR'), (key) => key, 'fr-FR');
    expect(fr.body).toContain('février');
  });

  it('every key is in English and translated in every base catalogue, with its placeholders', () => {
    const KEYS: Record<string, string[]> = {
      'bills.moveToShorterMonthTitle': ['{date}'],
      'bills.moveToShorterMonthBody': ['{day}', '{month}', '{newDay}'],
      'bills.moveToShorterMonthConfirm': [],
      'bills.moveToShorterMonthCancel': [],
    };
    const en = catalogue('en-US');
    for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = catalogue(locale);
      for (const [key, placeholders] of Object.entries(KEYS)) {
        expect(en[key], key).toBeTruthy();
        expect(messages[key], `${locale} ${key}`).toBeTruthy();
        expect(messages[key], `${locale} ${key} is translated`).not.toBe(en[key]);
        for (const p of placeholders) expect(messages[key], `${locale} ${key} keeps ${p}`).toContain(p);
      }
    }
  });
});

describe('both Mark paid buttons ask; nothing else does', () => {
  it('the Bill Manager asks through the shared confirm dialog, with its own date format', () => {
    const src = read('components/finance/bills-view.tsx');
    expect(src).toContain("import { useConfirm } from '@/components/ui/confirm';");
    expect(src).toContain('const askConfirm = useConfirm();');
    const body = bodyOf(src, 'async function markPaid(b: Bill) {', "success(reopen ? 'Reopened' : 'Marked paid');");
    expect(body).toContain('{ confirmClampedDay: (refusal) => askConfirm(dueDayNotKeptQuestion(refusal, t, fmtDueDate, locale.code)) }');
    // Declined: the refusal is still what the person is shown.
    expect(body).toContain("if (isDueDayNotKept(error)) { toastError(t('bills.dueDayNeedsDatabaseUpdate', { day: error.day })); return; }");
  });

  it('the Billing module asks through the same dialog, with its own date format', () => {
    const src = read('components/modules/billing-module.tsx');
    const body = bodyOf(src, 'async function markBillPaid(id: string) {', "success(tr('billingModule.billMarkedAsPaid'));");
    expect(body).toContain('{ confirmClampedDay: (refusal) => askConfirm(dueDayNotKeptQuestion(refusal, tr, fmtDate, locale.code)) }');
    expect(body).toContain("if (isDueDayNotKept(error)) return toastError(tr('bills.dueDayNeedsDatabaseUpdate', { day: error.day }));");
  });

  it('only a client component that can ask a person passes confirmClampedDay', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (name === 'node_modules' || name.startsWith('.')) continue;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name)) files.push(rel);
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(dir);
    const askers = files.filter((f) => read(f).includes('confirmClampedDay:'));
    expect(askers.sort()).toEqual(['components/finance/bills-view.tsx', 'components/modules/billing-module.tsx']);
    for (const f of askers) {
      expect(read(f), `${f} is a client component`).toMatch(/^\s*['"]use client['"]/);
      expect(read(f), `${f} asks through useConfirm`).toContain('confirmClampedDay: (refusal) => askConfirm(');
    }
  });
});
