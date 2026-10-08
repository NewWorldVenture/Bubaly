import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { billPaidPatch } from '@/lib/finance/recurring';
import { saveBillPayment, isMissingBillDueDay } from '@/lib/finance/bills';
import { wroteNoRows, describeDbError } from '@/lib/supabase/errors';
import { bill, store } from './helpers/recurring-bill-store';

// Execute the actual view callbacks with synthetic transport. Reintroducing
// main's monthly/anchor guessing, missing-stamp CAS, or clamp confirmation
// changes these observable outcomes even if source comments still promise safety.
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
    function setup(db: ReturnType<typeof store>, today: string) {
      const env = {
        createClient: () => db.client,
        familyId: 'synthetic-family',
        clock: { todayKey: () => today },
        billPaidPatch,
        saveBillPayment,
        isMissingBillDueDay,
        wroteNoRows,
        describeDbError,
        paymentOwner: { familyId: 'synthetic-family', userId: 'synthetic-user' },
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
    it('asks for an ambiguous legacy schedule without writing', async () => {
      const row = bill({ due_date: '2026-02-28', recurrence: null }),
        db = store(row),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(b.env.setPaymentSelection).toHaveBeenCalledWith({ bill: row, owner: b.env.paymentOwner });
      // Preserve the exact owner epoch, rather than a reconstructed equal key.
      expect(b.env.setPaymentSelection.mock.calls[0][0].owner).toBe(b.env.paymentOwner);
      expect(db.requests).toHaveLength(0);
      expect(b.env.success).not.toHaveBeenCalled();
    });
    it('refuses an older-schema clamp and never offers to change the original day', async () => {
      const row = bill(),
        db = store(row, true),
        b = setup(db, row.due_date);
      await b.run(row);
      expect(db.requests).toHaveLength(1);
      expect(db.current()).toEqual(row);
      expect(b.env.toastError).toHaveBeenCalledWith('bills.scheduleUnavailable');
      expect(b.env.success).not.toHaveBeenCalled();
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
