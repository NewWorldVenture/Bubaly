import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { isManager } from '@/lib/constants/roles';
import * as schedule from '@/lib/finance/hub';
import { saveBillPayment, saveBillPaymentBefore0488, isMissingBillDueDay } from '@/lib/finance/bills';
import { dueDayNotKeptQuestion, isDueDayNotKept, writeBillPatch } from '@/lib/finance/recurring';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { bill } from './helpers/recurring-bill-store';

const views = ['components/finance/bills-view.tsx', 'components/modules/billing-module.tsx'];
function actualFunction(file: string, name: string, env: Record<string, unknown>) {
  const source = readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(ast).replace(/^export\s+/, ''); ts.forEachChild(node, visit); }
  visit(ast); if (!body) throw new Error(`Missing actual ${name}`);
  const js = ts.transpileModule(`function factory(env:any){const {${Object.keys(env).join(',')}}=env;${body};return ${name};}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(`${js};return factory;`)()(env);
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function transport(held = false, refused = false, missingColumn = false) {
  const pending = deferred(), requests: { method: string; url: URL; body: unknown }[] = [];
  const client = createClient('https://synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    requests.push({ method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (held) await pending.promise;
    if (missingColumn && requests.length === 1) return Response.json({ code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" }, { status: 400 });
    return refused ? Response.json({ code: '42501', message: 'synthetic RLS refusal' }, { status: 403 }) : Response.json([{ id: 'synthetic-bill' }]);
  } } });
  return { client, requests, release: pending.release };
}

const callbackCases = [
  [views[0], 'markPaid', bill()], [views[0], 'toggleAutopay', bill()], [views[0], 'remove', 'synthetic-bill'],
  [views[1], 'markBillPaid', bill()], [views[1], 'deleteBill', 'synthetic-bill'], [views[1], 'deleteAccount', 'synthetic-account'],
] as const;
describe('actual browser-write callbacks and real SDK', () => {
  function setup(file: string, name: string, db: ReturnType<typeof transport>, role = 'parent') {
    const owner = { role }, currentBillOwner = { current: owner }, confirmation = deferred();
    const canManage = isManager(role);
    const source = readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let guard = '';
    function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'canWrite') guard = node.initializer!.getText(ast); ts.forEachChild(node, visit); } visit(ast);
    if (!guard) throw new Error('Missing real owner guard');
    const canWrite = new Function('canManage', 'currentBillOwner', 'scheduleOwner', `return ${guard};`)(canManage, currentBillOwner, owner);
    const env = { canWrite, createClient: () => db.client, familyId: 'synthetic-family', clock: { todayKey: () => '2026-01-01' },
      billPaidPatch: schedule.billPaidPatch, saveBillPayment, isMissingBillDueDay, wroteNoRows, describeDbError,
      saveBillPaymentBefore0488, isDueDayNotKept, dueDayNotKeptQuestion, fmtDueDate: (day: string) => day, fmtDate: (day: string) => day, locale: { code: 'en-US' },
      paymentOwner: owner, paymentTicket: { current: 0 }, currentPayment: { current: null }, setPaymentSelection: vi.fn(),
      t: (key: string) => key, tr: (key: string) => key, toastError: vi.fn(), success: vi.fn(), refresh: vi.fn(), refreshBills: vi.fn(), refreshAccounts: vi.fn(),
      confirm: () => true, askConfirm: () => confirmation.promise.then(() => true) };
    return { run: actualFunction(file, name, env), env, revoke: () => { currentBillOwner.current = { role: 'child' }; }, confirm: confirmation.release };
  }
  it.each(callbackCases)('%s %s refuses a nonmanager before SDK or confirmation', async (file, name, arg) => {
    const db = transport(), host = setup(file, name, db, 'child'); await host.run(arg);
    expect(db.requests).toEqual([]); expect(host.env.success).not.toHaveBeenCalled();
  });
  it.each(callbackCases)('%s %s rejects a retained manager callback after owner change', async (file, name, arg) => {
    const db = transport(), host = setup(file, name, db); host.revoke(); await host.run(arg);
    expect(db.requests).toEqual([]); expect(host.env.success).not.toHaveBeenCalled();
  });
  it.each(callbackCases)('%s %s keeps current parent/adult writes and refuses real SDK errors', async (file, name, arg) => {
    for (const role of ['parent', 'adult']) {
      const db = transport(), host = setup(file, name, db, role); const work = host.run(arg); host.confirm(); await work;
      expect(db.requests).toHaveLength(1); expect(host.env.success).toHaveBeenCalledTimes(1);
      const refused = transport(false, true), denied = setup(file, name, refused, role); const refusal = denied.run(arg); denied.confirm(); await refusal;
      expect(refused.requests).toHaveLength(1); expect(denied.env.success).not.toHaveBeenCalled(); expect(denied.env.toastError).toHaveBeenCalledTimes(1);
    }
  });
  it.each(callbackCases)('%s %s discards a late SDK success from an old owner', async (file, name, arg) => {
    const db = transport(true), host = setup(file, name, db); const work = host.run(arg); host.confirm();
    await vi.waitFor(() => expect(db.requests).toHaveLength(1)); host.revoke(); db.release(); await work;
    expect(host.env.success).not.toHaveBeenCalled(); expect(host.env.toastError).not.toHaveBeenCalled();
    expect(host.env.refresh).not.toHaveBeenCalled(); expect(host.env.refreshBills).not.toHaveBeenCalled(); expect(host.env.refreshAccounts).not.toHaveBeenCalled();
    expect(db.requests[0].url.searchParams.get('family_id')).toBe('eq.synthetic-family');
  });
  it.each([['deleteBill', views[1]], ['deleteAccount', views[1]]])('%s rechecks the owner after confirmation awaits', async (name, file) => {
    const db = transport(), host = setup(file, name, db); const work = host.run('synthetic-id'); host.revoke(); host.confirm(); await work;
    expect(db.requests).toEqual([]);
  });
  it.each([['markPaid', views[0]], ['markBillPaid', views[1]]])('%s never retries an old-schema payment after owner retirement', async (name, file) => {
    const db = transport(true, false, true), host = setup(file, name, db);
    const work = host.run(bill({ due_date: '2026-01-01' }));
    await vi.waitFor(() => expect(db.requests).toHaveLength(1)); host.revoke(); db.release(); await work;
    expect(db.requests).toHaveLength(1); expect(host.env.success).not.toHaveBeenCalled(); expect(host.env.toastError).not.toHaveBeenCalled();
  });
});

type Element = React.ReactElement<Record<string, unknown>>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement(value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
const modalCases = [
  [views[0], 'BillModal', [['bills.billName', 'Rent'], ['bills.amount', '100']]],
  [views[1], 'AddBillModal', [['billing.billName', 'Rent'], ['billing.amount', '100'], ['billing.dueDate', '2026-01-31']]],
  [views[1], 'AddAccountModal', [['billing.accountName', 'Bank']]],
  ['components/finance/bill-payment-modal.tsx', 'BillPaymentModal', []],
] as const;
describe('actual modal hooks before passive cleanup', () => {
  function mount(file: string, name: string, fields: readonly (readonly [string, string])[], db: ReturnType<typeof transport>, recurring = false) {
    const slots: unknown[] = []; let cursor = 0, current = true;
    const success = vi.fn(), error = vi.fn(), done = vi.fn(), close = vi.fn();
    const env = { React, useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef: (initial: unknown) => { const i = cursor++; return slots[i] ??= { current: initial }; }, useEffect: () => {},
    useTranslations: () => (key: string) => key, useToast: () => ({ success, error }), useApp: () => ({ family: { timezone: 'UTC' } }),
    useFamilyClock: () => ({ todayKey: () => '2026-01-01' }), todayInZone: () => '2026-01-31', createClient: () => db.client,
    saveBillPayment, isMissingBillDueDay, writeBillPatch, describeDbError, wroteNoRows, ...schedule,
    useLocale: () => ({ code: 'en-US' }), useConfirm: () => async () => false, useFormat: () => ({ fmtDate: (day: string) => day }),
    dueDayNotKeptQuestion, isDueDayNotKept,
    Modal: () => null, Input: () => null, Field: () => null, Select: () => null, Button: () => null, CATEGORIES: ['Other'], BILL_CATEGORIES: ['Other'] };
    const component = actualFunction(file, name, env);
    const render = () => { cursor = 0; return component({ bill: bill({ due_date: '2026-01-01' }), familyId: 'synthetic-family', userId: 'synthetic-user', open: true, defaultAutopay: false, isCurrent: () => current, onDone: done, onClose: close }); };
    for (const [label, value] of fields) {
      const field = elements(render()).find(item => item.props.label === label); if (!field) throw new Error(`Missing actual field ${label}`);
      const input = (field.props.children as (id: string) => Element)('synthetic-field');
      (input.props.onChange as (event: unknown) => void)({ target: { value } });
    }
    if (recurring && name === 'AddBillModal') {
      const checkbox = elements(render()).find(item => item.props.id === 'recurring')!;
      (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    }
    const form = elements(render()).find(item => item.type === 'form')!;
    return { submit: () => (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} }), revoke: () => { current = false; }, success, error, done, close };
  }
  it.each(modalCases)('%s %s retained submit refuses a retired owner/instance', async (file, name, fields) => {
    const db = transport(), host = mount(file, name, fields, db); host.revoke(); await host.submit(); expect(db.requests).toEqual([]);
  });
  it.each(modalCases)('%s %s double submit before rerender dispatches once', async (file, name, fields) => {
    const db = transport(true), host = mount(file, name, fields, db); const one = host.submit(), two = host.submit();
    await vi.waitFor(() => expect(db.requests).toHaveLength(1)); db.release(); await Promise.all([one, two]); expect(host.success).toHaveBeenCalledTimes(1); expect(host.close).toHaveBeenCalledTimes(1);
  });
  it.each(modalCases)('%s %s retired response cannot toast, reset or close another modal', async (file, name, fields) => {
    for (const refused of [false, true]) {
      const db = transport(true, refused), host = mount(file, name, fields, db); const work = host.submit();
      await vi.waitFor(() => expect(db.requests).toHaveLength(1)); host.revoke(); db.release(); await work;
      expect(host.success).not.toHaveBeenCalled(); expect(host.error).not.toHaveBeenCalled(); expect(host.done).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled();
    }
  });
  it.each(modalCases.filter(([, name]) => name !== 'AddAccountModal'))('%s %s refuses compatibility fallback after instance retirement', async (file, name, fields) => {
    const db = transport(true, false, true), host = mount(file, name, fields, db, true); const work = host.submit();
    await vi.waitFor(() => expect(db.requests).toHaveLength(1));
    expect(db.requests[0].body).toHaveProperty('due_day'); host.revoke(); db.release(); await work;
    expect(db.requests).toHaveLength(1); expect(host.success).not.toHaveBeenCalled(); expect(host.error).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled();
  });
});
