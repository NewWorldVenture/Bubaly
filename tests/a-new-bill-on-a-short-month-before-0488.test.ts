import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { writeBillPatch, dueDayNotKeptQuestion, isDueDayNotKept } from '@/lib/finance/recurring';
import { isMissingBillDueDay } from '@/lib/finance/bills';
import { describeDbError } from '@/lib/supabase/errors';
import { bill, store } from './helpers/recurring-bill-store';

// Execute the actual add-bill submit callbacks with synthetic transport. A
// day the first month lacks (day 31, first date Apr 30) was never refused by
// production before 0488: without bills.due_day the person is asked whether
// to add it due on that date, and the insert goes ahead only on yes.
function submitOf(file: string, modal: string, env: Record<string, unknown>) {
  const source = readFileSync(file, 'utf8'),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  const find = (node: ts.Node, inModal: boolean) => {
    const here = inModal || (ts.isFunctionDeclaration(node) && node.name?.text === modal);
    if (here && ts.isFunctionDeclaration(node) && node.name?.text === 'submit') body = node.getText(ast);
    ts.forEachChild(node, (child) => find(child, here));
  };
  find(ast, false);
  if (!body) throw new Error(`Missing ${modal} submit`);
  const js = ts.transpileModule(
    `function factory(env:any) {const {${Object.keys(env).join(',')}}=env;${body};return submit;}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } },
  ).outputText;
  return new Function(`${js};return factory;`)()(env) as (e: { preventDefault: () => void }) => Promise<void>;
}

const forms = [
  {
    file: 'components/finance/bills-view.tsx',
    modal: 'BillModal',
    fields: (dueDate: string, day: number) => ({
      v: { name: 'Rent', amount: '100', due_date: dueDate, due_day: String(day), category: 'Utilities', is_recurring: true, recurrence: 'monthly', autopay: false },
    }),
  },
  {
    file: 'components/modules/billing-module.tsx',
    modal: 'AddBillModal',
    fields: (dueDate: string, day: number) => ({
      name: 'Rent', amount: '100', dueDate, isRecurring: true, recurrence: 'monthly', anchorDay: String(day), category: 'Other',
    }),
  },
];

for (const form of forms)
  describe(`${form.modal} submit`, () => {
    function setup(db: ReturnType<typeof store>, dueDate: string, day: number, answer = false) {
      const env = {
        ...form.fields(dueDate, day),
        needsDay: true,
        alive: { current: true },
        inFlight: { current: false },
        isCurrent: () => true,
        setSaving: vi.fn(),
        familyId: 'synthetic-family',
        userId: 'synthetic-user',
        createClient: () => db.client,
        writeBillPatch,
        dueDayNotKeptQuestion,
        isDueDayNotKept,
        isMissingBillDueDay,
        describeDbError,
        askConfirm: vi.fn(async () => answer),
        fmtDueDateIn: (d: string) => d,
        fmtDate: (d: string) => d,
        locale: { code: 'en-US' },
        t: (key: string) => key,
        tr: (key: string) => key,
        toastError: vi.fn(),
        success: vi.fn(),
        onClose: vi.fn(),
        onDone: vi.fn(),
        reset: vi.fn(),
      };
      return { env, run: () => submitOf(form.file, form.modal, env)({ preventDefault: () => {} }) };
    }
    const inserted = (db: ReturnType<typeof store>) => db.requests.map((r) => r.patch);

    it('older schema: day 31 starting on Apr 30 is added there only on yes', async () => {
      for (const answer of [false, true]) {
        const db = store(bill(), true),
          b = setup(db, '2026-04-30', 31, answer);
        await b.run();
        expect(b.env.askConfirm).toHaveBeenCalledTimes(1);
        expect(b.env.askConfirm.mock.calls[0]).toEqual([
          expect.objectContaining({ title: 'bills.addOnShorterMonthTitle', confirmLabel: 'bills.addOnShorterMonthConfirm', destructive: false }),
        ]);
        expect(inserted(db)[0]).toMatchObject({ due_date: '2026-04-30', due_day: 31 });
        if (answer) {
          expect(inserted(db)).toHaveLength(2);
          expect(inserted(db)[1]).not.toHaveProperty('due_day');
          expect(inserted(db)[1]).toMatchObject({ due_date: '2026-04-30', recurrence: 'monthly' });
          expect(b.env.success).toHaveBeenCalled();
          expect(b.env.toastError).not.toHaveBeenCalled();
        } else {
          expect(inserted(db)).toHaveLength(1);
          expect(b.env.success).not.toHaveBeenCalled();
          // No: the form stays open for another day, with no error toast.
          expect(b.env.toastError).not.toHaveBeenCalled();
        }
      }
    });
    it('older schema: a day its date carries (the 30th) is added without asking', async () => {
      const db = store(bill(), true),
        b = setup(db, '2026-04-30', 30);
      await b.run();
      expect(b.env.askConfirm).not.toHaveBeenCalled();
      expect(inserted(db)).toHaveLength(2);
      expect(inserted(db)[1]).not.toHaveProperty('due_day');
      expect(b.env.success).toHaveBeenCalled();
    });
    it('with the column day 31 is stored and never asked about', async () => {
      const db = store(bill()),
        b = setup(db, '2026-04-30', 31);
      await b.run();
      expect(b.env.askConfirm).not.toHaveBeenCalled();
      expect(inserted(db)).toHaveLength(1);
      expect(inserted(db)[0]).toMatchObject({ due_date: '2026-04-30', due_day: 31 });
      expect(b.env.success).toHaveBeenCalled();
    });
    it('another refusal is surfaced, never asked about or retried', async () => {
      const failure = { code: '42501', message: 'permission denied for table bills' },
        db = store(bill(), true, failure),
        b = setup(db, '2026-04-30', 31, true);
      await b.run();
      expect(b.env.askConfirm).not.toHaveBeenCalled();
      expect(inserted(db)).toHaveLength(1);
      expect(b.env.toastError).toHaveBeenCalledTimes(1);
      expect(b.env.toastError).not.toHaveBeenCalledWith('bills.scheduleUnavailable');
      expect(b.env.success).not.toHaveBeenCalled();
    });
  });
