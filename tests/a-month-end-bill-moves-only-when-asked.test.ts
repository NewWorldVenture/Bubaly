import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { billPaidPatch, dueDayNotKeptQuestion, isDueDayNotKept } from '@/lib/finance/recurring';
import { saveBillPayment, saveBillPaymentBefore0488, isMissingBillDueDay } from '@/lib/finance/bills';
import { wroteNoRows, describeDbError } from '@/lib/supabase/errors';
import { bill, store } from './helpers/recurring-bill-store';

// Execute the actual view callbacks with synthetic transport. With
// bills.due_day an unknown schedule is confirmed by the person first; without
// it (0488 held, owner decision) the callbacks pay as production did before
// 0488, and a roll into a shorter month is asked about, never assumed.
function callback(file: string, name: string, env: Record<string, unknown>) {
  const source = readFileSync(file, 'utf8'),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!body) throw new Error(`Missing ${name}`);
  const js = ts.transpileModule(
    `function factory(env:any) {const {${Object.keys(env).join(',')}}=env;${body};return ${name};}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return new Function(`${js};return factory;`)()(env) as (row: ReturnType<typeof bill>) => Promise<void>;
}
for (const [file, name] of [
  ['components/finance/bills-view.tsx', 'markPaid'],
  ['components/modules/billing-module.tsx', 'markBillPaid'],
])
  describe(`${name} actual callback`, () => {
    function setup(db: ReturnType<typeof store>, today: string, answer = false) {
      const env = {
        createClient: () => db.client,
        familyId: 'synthetic-family',
        clock: { todayKey: () => today },
        billPaidPatch,
        saveBillPayment,
        saveBillPaymentBefore0488,
        isMissingBillDueDay,
        isDueDayNotKept,
        dueDayNotKeptQuestion,
        askConfirm: vi.fn(async () => answer),
        fmtDueDate: (day: string) => day,
        fmtDate: (day: string) => day,
        locale: { code: 'en-US' },
        wroteNoRows,
        describeDbError,
        paymentOwner: { familyId: 'synthetic-family', userId: 'synthetic-user' },
        canWrite: () => true,
        paymentTicket: { current: 0 },
        currentPayment: { current: null },
        setPaymentSelection: vi.fn(),
        toastError: vi.fn(),
        success: vi.fn(),
        refresh: vi.fn(),
        refreshBills: vi.fn(),
        t: (key: string) => key,
        tr: (key: string) => key,
      };
      return { env, run: callback(file, name, env) };
    }
    // With bills.due_day a `*` read carries the key (null for an unknown day).
    it('asks for an ambiguous schedule without writing when the column exists', async () => {
      const row = bill({ due_date: '2026-02-28', recurrence: null, due_day: null }),
        db = store(row),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(b.env.setPaymentSelection).toHaveBeenCalledWith({ bill: row, owner: b.env.paymentOwner, ticket: 1 });
      // Preserve the exact owner epoch, rather than a reconstructed equal key.
      expect(b.env.setPaymentSelection.mock.calls[0][0].owner).toBe(b.env.paymentOwner);
      expect(db.requests).toHaveLength(0);
      expect(db.reads).toHaveLength(0);
      expect(b.env.success).not.toHaveBeenCalled();
    });
    it('still asks for the schedule when a row without the key meets a database that has the column', async () => {
      const row = bill({ due_date: '2026-03-30' }),
        db = store(row),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.reads).toHaveLength(1);
      expect(db.reads[0].searchParams.get('select')).toBe('due_day');
      expect(db.requests).toHaveLength(0);
      expect(b.env.setPaymentSelection).toHaveBeenCalledTimes(1);
      expect(b.env.success).not.toHaveBeenCalled();
    });
    // Owner decision (0488 held): the previous production behaviour, not a refusal.
    it.each([
      { name: 'a cadence-less recurring bill rolls monthly', over: { due_date: '2026-02-28', recurrence: null }, next: '2026-03-28' },
      { name: 'a bill due on the 30th rolls to the 30th', over: { due_date: '2026-03-30' }, next: '2026-04-30' },
      { name: 'a bill due on the 28th rolls to the 28th', over: { due_date: '2026-03-28' }, next: '2026-04-28' },
    ])('older schema: $name, as before 0488', async ({ over, next }) => {
      const row = bill(over),
        db = store(row, true),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.reads).toHaveLength(1);
      expect(b.env.askConfirm).not.toHaveBeenCalled();
      expect(b.env.setPaymentSelection).not.toHaveBeenCalled();
      expect(db.current()).toMatchObject({ status: 'upcoming', due_date: next, recurrence: row.recurrence });
      expect(db.current()).not.toHaveProperty('due_day');
      // The compare-and-swap guard is on the write that landed.
      expect(db.requests.at(-1)!.url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
      expect(b.env.success).toHaveBeenCalled();
    });
    it('older schema: a day-30 bill rolling into February moves only on yes', async () => {
      for (const answer of [false, true]) {
        const row = bill({ due_date: '2026-01-30' }),
          db = store(row, true),
          b = setup(db, row.due_date, answer);
        await b.run(row);
        expect(b.env.askConfirm).toHaveBeenCalledTimes(1);
        expect(b.env.askConfirm.mock.calls[0]).toEqual([expect.objectContaining({ title: 'bills.moveToShorterMonthTitle', destructive: false })]);
        if (answer) {
          expect(db.current()).toMatchObject({ status: 'upcoming', due_date: '2026-02-28' });
          expect(b.env.success).toHaveBeenCalled();
        } else {
          expect(db.current()).toEqual(row);
          expect(b.env.toastError).toHaveBeenCalledWith('bills.dueDayNeedsDatabaseUpdate');
          expect(b.env.success).not.toHaveBeenCalled();
        }
      }
    });
    it('older schema: a probe refused for another reason surfaces it and writes nothing', async () => {
      const failure = { code: '42501', message: 'permission denied for table bills' },
        row = bill({ due_date: '2026-03-30' }),
        db = store(row, true, failure),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.requests).toHaveLength(0);
      expect(b.env.setPaymentSelection).not.toHaveBeenCalled();
      expect(b.env.toastError).toHaveBeenCalledTimes(1);
      expect(b.env.toastError).not.toHaveBeenCalledWith('bills.scheduleUnavailable');
      expect(b.env.success).not.toHaveBeenCalled();
    });
    // Owner decision (0488 held) reverses the earlier refusal: as before 0488,
    // the person is asked whether to move a 31st bill to Feb 28.
    it('asks before an older-schema clamp and leaves the bill as it was on no', async () => {
      const row = bill(),
        db = store(row, true),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(b.env.askConfirm).toHaveBeenCalledTimes(1);
      expect(db.requests).toHaveLength(1);
      expect(db.current()).toEqual(row);
      expect(b.env.toastError).toHaveBeenCalledWith('bills.dueDayNeedsDatabaseUpdate');
      expect(b.env.success).not.toHaveBeenCalled();
    });
    it('moves an older-schema 31st bill to Feb 28 on yes, through the same guard', async () => {
      const row = bill(),
        db = store(row, true),
        b = setup(db, row.due_date, true);
      await b.run(row);
      expect(db.requests).toHaveLength(2);
      expect(db.requests[1].patch).not.toHaveProperty('due_day');
      expect(db.requests[1].url.searchParams.get('updated_at')).toBe(`eq.${row.updated_at}`);
      expect(db.current()).toMatchObject({ status: 'upcoming', due_date: '2026-02-28' });
      expect(b.env.success).toHaveBeenCalled();
    });
    it('with the column a 31st bill keeps its day and is never asked about', async () => {
      const row = bill({ due_day: 31 }),
        db = store(row),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(b.env.askConfirm).not.toHaveBeenCalled();
      expect(db.reads).toHaveLength(0);
      expect(db.current()).toMatchObject({ due_date: '2026-02-28', due_day: 31 });
    });
    it('rejects a stale amount edit under the button', async () => {
      const row = bill(),
        changed = bill({ amount: 200, updated_at: '2026-01-02T00:00:00Z' }),
        db = store(changed),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.current()).toEqual(changed);
      expect(b.env.success).not.toHaveBeenCalled();
      expect(b.env.toastError).toHaveBeenCalled();
    });
    it('marks one-offs paid without rolling their date', async () => {
      const row = bill({ is_recurring: false }),
        db = store(row),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.current()).toMatchObject({ status: 'paid', due_date: row.due_date });
      expect(b.env.success).toHaveBeenCalled();
    });
    it('saves safe ordinary payments on an older schema', async () => {
      const row = bill({ due_date: '2026-01-15' }),
        db = store(row, true),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.current().due_date).toBe('2026-02-15');
      expect(b.env.success).toHaveBeenCalled();
    });
  });
