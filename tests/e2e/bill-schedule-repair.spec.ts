import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Synthetic identity/AAL2 seams; actual UI, server action, CAS helper and SDK.
// This proves the repair workflow, not live Auth/RLS or deployment state.
const { react, reactDom } = reactBrowserScripts('development');
const messages: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const sources = Object.fromEntries([
  'components/finance/bills-view.tsx', 'components/modules/billing-module.tsx',
  'components/finance/bill-schedule-modal.tsx', 'components/finance/bill-payment-modal.tsx',
  'components/ui/modal.tsx', 'components/ui/input.tsx', 'components/ui/button.tsx',
  'components/ui/badge.tsx', 'components/ui/states.tsx', 'components/ui/states-client.tsx',
  'components/ui/toast.tsx', 'lib/hooks/use-media-query.ts', 'components/app/page-header.tsx', 'lib/a11y/use-dialog-behavior.ts',
  'lib/finance/hub.ts', 'lib/finance/bills.ts', 'lib/finance/bill-schedule.ts', 'lib/finance/recurring.ts',
  'lib/finance/category-label.ts', 'lib/calendar/occurrences.ts', 'lib/calendar/recurrence.ts',
  'lib/calendar/source-capability.ts', 'lib/calendar/exact-instant.ts', 'lib/onboarding/ics-time.ts', 'lib/calendar/day.ts', 'lib/briefing/calendar-window.ts',
  'lib/time/zoned.ts', 'lib/time/local-day.ts', 'lib/time/wall-clock.ts', 'lib/i18n/locales.ts',
  'lib/supabase/errors.ts', 'lib/schedule/zoned.ts', 'lib/auth/step-up-client.ts', 'lib/auth/mfa.ts',
  // billing-module settles its delete through settleAction, so a rejected
  // server-action call is reported and the list re-read, not lost.
  'lib/ui/settle-action.ts',
  'lib/auth/redirect.ts', 'lib/constants/roles.ts', 'lib/constants/plans.ts', 'lib/constants/feature-catalog.ts',
  'lib/billing/plans.ts', 'lib/billing/review-selection.ts', 'lib/wallet/ledger.ts',
  'lib/utils/calendar-date.ts', 'lib/utils/birthday.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText]));
sources['@/lib/constants/family-prices.json'] = `module.exports = ${fs.readFileSync('lib/constants/family-prices.json', 'utf8')}; module.exports.default = module.exports;`;

const initial = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', family_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Synthetic unpaid rent', amount: 100,
  due_date: '2026-03-28', due_day: null, status: 'overdue', is_recurring: true, recurrence: 'monthly', category: null, autopay: false,
  created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
type Row = typeof initial;
type Mode = 'healthy' | 'old-schema' | 'stale' | 'step-up' | 'held';
function server(mode: Mode, role = 'parent') {
  let row: Row = { ...initial };
  if (mode === 'stale') row.updated_at = '2026-01-02T00:00:00Z';
  const writes: { query: string; patch: Record<string, unknown> }[] = [], paths: string[] = [];
  let release: (() => void) | undefined;
  const client = createClient('https://synthetic-schedule.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (!['/rest/v1/bills', '/rest/v1/financial_accounts'].includes(url.pathname) || !['POST', 'PATCH', 'DELETE'].includes(init?.method ?? '')) throw new Error('Unexpected synthetic operation');
      const patch = JSON.parse(String(init?.body ?? '{}')); writes.push({ query: url.search, patch });
      if (mode === 'held') await new Promise<void>(resolve => { release = resolve; });
      if (mode === 'old-schema') return Response.json({ code: '42703', message: 'column bills.due_day does not exist' }, { status: 400 });
      const matches = [...url.searchParams].every(([key, predicate]) => key === 'select' || (predicate === 'is.null' ? row[key as keyof Row] == null : predicate === `eq.${row[key as keyof Row]}`));
      if (matches) row = { ...row, ...patch, updated_at: '2026-02-01T00:00:00Z' };
      return Response.json(matches ? [{ id: row.id }] : []);
    } },
  });
  const mocks: Record<string, unknown> = {
    'server-only': {},
    'next/cache': { revalidatePath: (value: string) => paths.push(value) },
    '@/lib/i18n/server': { getTranslations: async () => (key: string) => messages[key] ?? key },
    '@/lib/supabase/auth': { requireUserContext: async () => ({ user: { id: 'synthetic-owner' }, active: { familyId: initial.family_id, role, member: { id: 'synthetic-member' }, family: { timezone: 'UTC' } } }) },
    '@/lib/auth/require-aal2': { aal2Verdict: async () => mode === 'step-up' ? { action: 'step_up', to: '/auth/step-up', reason: 'needs_code' } : { action: 'allow' } },
    '@/lib/supabase/server': { createServer: async () => client },
    '@/lib/services/finances': {},
  };
  const allowed = new Set(['app/(app)/dashboard/billing/actions.ts', 'lib/services/scope.ts', 'lib/time/zoned.ts', 'lib/constants/roles.ts', 'lib/finance/bills.ts', 'lib/finance/bill-schedule.ts', 'lib/finance/recurring.ts', 'lib/calendar/occurrences.ts', 'lib/calendar/recurrence.ts', 'lib/calendar/day.ts', 'lib/calendar/source-capability.ts', 'lib/calendar/exact-instant.ts', 'lib/onboarding/ics-time.ts', 'lib/briefing/calendar-window.ts', 'lib/supabase/errors.ts']);
  const modules: Record<string, { exports: Record<string, unknown> }> = {};
  function load(file: string): Record<string, unknown> {
    if (!allowed.has(file)) throw new Error(`Unexpected server schedule module ${file}`);
    if (modules[file]) return modules[file].exports;
    const entry = { exports: {} }; modules[file] = entry;
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', code)((id: string) => {
      if (id in mocks) return mocks[id];
      return load((id.startsWith('@/') ? id.slice(2) : path.posix.normalize(path.posix.dirname(file) + '/' + id)) + '.ts');
    }, entry, entry.exports);
    return entry.exports;
  }
  const action = load('app/(app)/dashboard/billing/actions.ts').confirmBillScheduleAction as (snapshot: unknown, choice: unknown) => Promise<unknown>;
  return { writes, paths, row: () => row, release: () => release?.(), async confirm(snapshot: unknown, choice: unknown) { return { result: await action(snapshot, choice), row }; },
    async browserWrite(table: string, steps: [string, unknown[]][]) {
      if (!['bills', 'financial_accounts'].includes(table)) throw new Error('Unexpected browser table');
      let query: unknown = client.from(table as 'bills');
      for (const [method, args] of steps) {
        if (!['insert', 'update', 'delete', 'eq', 'filter', 'select'].includes(method)) throw new Error('Unexpected browser method');
        query = (query as Record<string, (...values: unknown[]) => unknown>)[method].apply(query, args);
      }
      return await query;
    },
  };
}

async function fixture(page: Page, view: 'bills' | 'billing' = 'bills', mode: Mode = 'healthy', role = 'parent') {
  const actual = server(mode, role), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__confirmSchedule', actual.confirm);
  await page.exposeFunction('__billWrite', actual.browserWrite);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }));
  await page.goto('https://synthetic-schedule-ui.invalid');
  await page.addScriptTag({ content: react }); await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const React=window.React,sources=${JSON.stringify(sources)},messages=${JSON.stringify(messages)},cache={},listeners=new Set();
    const p=window.__schedule={row:${JSON.stringify(initial)},owner:'owner-a',familyId:${JSON.stringify(initial.family_id)},role:${JSON.stringify(role)},refreshes:0,toasts:[],switch(owner,familyId,role=p.role){p.owner=owner;p.familyId=familyId;p.role=role;for(const notify of listeners)notify();}};
    const tr=(key,params)=>Object.entries(params||{}).reduce((value,[key,arg])=>value.replaceAll('{'+key+'}',String(arg)),messages[key]||key);
    const inert=()=>null;
    const mocks={react:React,'react-dom':window.ReactDOM,'lucide-react':new Proxy({}, {get:()=>inert}),
      '@/lib/utils/cn':{cn:(...values)=>values.filter(value=>typeof value==='string').join(' ')},
      'next/navigation':{useSearchParams:()=>new URLSearchParams()},'next/link':{__esModule:true,default:({children,...props})=>React.createElement('a',props,children)},
      'date-fns':{parseISO:value=>new Date(value)},
      '@/components/app/app-context':{useApp:()=>{React.useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback)},()=>p.owner+':'+p.familyId+':'+p.role);return{familyId:p.familyId,userId:p.owner,role:p.role,members:[],family:{timezone:'UTC'}};}},
      '@/components/i18n/locale-provider':{useTranslations:()=>tr,usePlural:()=>(key,count,params)=>tr(key+(count===1?'.one':'.other'),{...params,count}),useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},
      '@/components/i18n/use-format':{useFamilyCalendarToday:()=>new Date(2026,2,1,12),useFamilyClock:()=>({todayKey:()=> '2026-03-01'}),useFormat:()=>({fmtDate:value=>value})},
      '@/components/ui/avatar':{Avatar:inert},'@/components/ai/ai-insight':{AiInsight:inert},
      '@/components/billing/family-value-comparison':{FamilyValueComparison:inert},'@/components/billing/family-delivered-value':{FamilyDeliveredValue:inert},'@/components/billing/selected-plan-review':{SelectedPlanReview:inert},
      '@/lib/marketing/value':{PLAN_CURRENCY:'USD'},
      '@/lib/hooks/use-billing-subscription':{useBillingSubscription:()=>({subscription:null,status:'ready',reload(){},isCurrentReady:()=>true})},
      '@/components/ui/confirm':{useConfirm:()=>async()=>false},
      '@/lib/hooks/use-realtime-query':{useRealtimeQuery:({table})=>({data:table==='bills'&&p.familyId===p.row.family_id?[p.row]:[],loading:false,error:null,stale:false,refresh(){p.refreshes++;for(const notify of listeners)notify();}})},
      '@/lib/supabase/client':{createClient(){return{from(table){const steps=[],query={then(resolve,reject){return window.__billWrite(table,steps).then(resolve,reject)}};for(const method of ['insert','update','delete','eq','filter','select'])query[method]=(...args)=>{steps.push([method,args]);return query};return query}}}},
      '@/app/(app)/dashboard/billing/actions':{async confirmBillScheduleAction(snapshot,choice){const answer=await window.__confirmSchedule(snapshot,choice);if(answer.result.ok)p.row=answer.row;return answer.result;},createSavingsGoalAction(){throw new Error('Unexpected savings write')},createTransactionAction(){throw new Error('Unexpected transaction write')},deleteBudgetAction(){throw new Error('Unexpected budget write')},deleteSavingsGoalAction(){throw new Error('Unexpected savings write')},deleteTransactionAction(){throw new Error('Unexpected transaction write')},setBudgetAction(){throw new Error('Unexpected budget write')}},
    };
    function load(name){if(name in mocks)return mocks[name];if(name in cache)return cache[name].exports;if(!(name in sources))throw new Error('Unexpected schedule fixture module '+name);const module={exports:{}};cache[name]=module;new Function('require','module','exports','React',sources[name])(child=>load(child === '../onboarding/ics-time' ? '@/lib/onboarding/ics-time' : child === '../calendar/exact-instant' ? '@/lib/calendar/exact-instant' : child === '../time/zoned' ? '@/lib/time/zoned' : child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child),module,module.exports,React);return module.exports;}
    const Toast=load('@/components/ui/toast').ToastProvider;
    const View=load(${JSON.stringify(view === 'bills' ? '@/components/finance/bills-view' : '@/components/modules/billing-module')})[${JSON.stringify(view === 'bills' ? 'BillsView' : 'BillingModule')}];
    window.ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Toast,null,React.createElement(View,{mode:'all'})));
  })();` });
  await page.waitForTimeout(50);
  expect(errors, 'The real view must mount without missing fixture modules').toEqual([]);
  await expect(page.getByText('Synthetic unpaid rent', { exact: true }).first()).toBeVisible();
  return { actual, errors };
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Edit schedule' });
async function choose(page: Page) { await page.getByRole('button', { name: 'Edit schedule', exact: true }).first().click(); await expect(dialog(page)).toBeVisible(); await dialog(page).getByRole('combobox', { name: 'Day of month' }).selectOption('31'); }

for (const view of ['bills', 'billing'] as const) {
  test(`${view} edits an unpaid legacy schedule through real server action and CAS SDK without paying`, async ({ page }) => {
    const proof = await fixture(page, view); await choose(page);
    await expect(dialog(page).getByText('Current due date stays 2026-03-28.')).toBeVisible();
    await expect(dialog(page).getByRole('status')).toContainText('2026-04-30');
    await dialog(page).getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(proof.actual.row()).toMatchObject({ due_date: initial.due_date, status: 'overdue', due_day: 31 });
    expect(proof.actual.writes).toHaveLength(1); expect(proof.actual.writes[0].patch).not.toHaveProperty('status');
    expect(proof.actual.paths).toEqual(['/dashboard/bills', '/dashboard/billing', '/dashboard/money-timeline']);
    expect(proof.errors).toEqual([]);
  });
}
test('unknown legacy anchor is blank and cannot silently submit; cancel is a zero-write operation', async ({ page }) => {
  const proof = await fixture(page); await page.getByRole('button', { name: 'Edit schedule', exact: true }).click();
  await expect(dialog(page).getByRole('combobox', { name: 'Day of month' })).toHaveValue('');
  await expect(dialog(page).getByRole('button', { name: 'Save schedule' })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(proof.actual.writes).toEqual([]); expect(proof.actual.row()).toEqual(initial); expect(proof.errors).toEqual([]);
});
test('Billing Bills tab has the same standalone repair entrypoint', async ({ page }) => {
  const proof = await fixture(page, 'billing');
  await page.getByRole('button', { name: messages['billingModule.tab.bills'], exact: true }).click();
  await choose(page);
  await expect(dialog(page).getByText('This saves the schedule without marking the bill paid.')).toBeVisible();
  expect(proof.actual.writes).toEqual([]); expect(proof.errors).toEqual([]);
});
for (const [mode, message] of [
  ['old-schema', 'Recurring bill schedules are not available yet. This change was not saved.'],
  ['stale', 'This bill changed. Refresh before confirming its schedule.'],
] as const) test(`${mode} keeps the current bill and shows a translated refusal without success`, async ({ page }) => {
  const proof = await fixture(page, 'bills', mode); const before = { ...proof.actual.row() }; await choose(page);
  await dialog(page).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(dialog(page)).toBeVisible();
  expect(proof.actual.row()).toEqual(before); expect(proof.actual.paths).toEqual([]); expect(proof.errors).toEqual([]);
});
for (const role of ['teen', 'child', 'caregiver', 'guest']) test(`${role} cannot open schedule repair controls`, async ({ page }) => {
  const proof = await fixture(page, 'bills', 'healthy', role);
  await expect(page.getByRole('button', { name: 'Edit schedule' })).toHaveCount(0); expect(proof.actual.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

for (const view of ['bills', 'billing'] as const) test(`${view} child reads bills but has no manager write controls`, async ({ page }) => {
  const proof = await fixture(page, view, 'healthy', 'child');
  if (view === 'billing') await page.getByRole('button', { name: messages['billingModule.tab.bills'], exact: true }).click();
  await expect(page.getByText('Synthetic unpaid rent', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: messages['billing.addBill'], exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: messages['bills.addBill'], exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Mark paid|Auto Pay|Delete/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: messages['billing.linkAccount'], exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: messages['billing.addAccount'], exact: true })).toHaveCount(0);
  expect(proof.actual.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

async function billTab(page: Page, view: 'bills' | 'billing') {
  if (view === 'billing') await page.getByRole('button', { name: messages['billingModule.tab.bills'], exact: true }).click();
}
async function openPayment(page: Page) {
  await page.getByRole('button', { name: /^Mark paid$/i }).first().click();
  const payment = page.getByRole('dialog', { name: messages['bills.confirmPaymentSchedule'] });
  await expect(payment).toBeVisible();
  await payment.getByRole('combobox', { name: messages['bills.dayOfMonth'] }).selectOption('31');
  return payment;
}
for (const view of ['bills', 'billing'] as const) {
  test(`${view} role ABA retires a pending payment and never resurrects it`, async ({ page }) => {
    const proof = await fixture(page, view, 'held'); await billTab(page, view); const payment = await openPayment(page);
    await payment.getByRole('button', { name: /^Mark paid$/i }).click(); await expect.poll(() => proof.actual.writes.length).toBe(1);
    await page.evaluate(family => { const state = (window as unknown as { __schedule: { switch(owner: string, family: string, role: string): void } }).__schedule; state.switch('owner-a', family, 'child'); }, initial.family_id);
    await expect(payment).toHaveCount(0); await expect(page.getByRole('button', { name: /^Mark paid$/i })).toHaveCount(0);
    await page.evaluate(family => (window as unknown as { __schedule: { switch(owner: string, family: string, role: string): void } }).__schedule.switch('owner-a', family, 'parent'), initial.family_id);
    proof.actual.release(); await page.waitForTimeout(80); await expect(payment).toHaveCount(0);
    await expect(page.getByText(messages['billingModule.billMarkedAsPaid'], { exact: true })).toHaveCount(0); expect(proof.actual.writes).toHaveLength(1); expect(proof.errors).toEqual([]);
  });
  test(`${view} a retired pending payment cannot close a newly opened payment`, async ({ page }) => {
    const proof = await fixture(page, view, 'held'); await billTab(page, view); const payment = await openPayment(page);
    await payment.getByRole('button', { name: /^Mark paid$/i }).click(); await expect.poll(() => proof.actual.writes.length).toBe(1);
    await payment.getByRole('button', { name: messages['bills.cancel'], exact: true }).click();
    await page.getByRole('button', { name: /^Mark paid$/i }).first().click(); await expect(payment).toBeVisible();
    await expect(payment.getByRole('combobox', { name: messages['bills.dayOfMonth'] })).toHaveValue(''); proof.actual.release(); await page.waitForTimeout(80);
    await expect(payment).toBeVisible(); await expect(page.getByText(messages['billingModule.billMarkedAsPaid'], { exact: true })).toHaveCount(0); expect(proof.actual.writes).toHaveLength(1); expect(proof.errors).toEqual([]);
  });
  test(`${view} a pending add-bill cannot close or reset the next form instance`, async ({ page }) => {
    const proof = await fixture(page, view, 'held'); await billTab(page, view);
    const addLabel = messages[view === 'bills' ? 'bills.addBill' : 'billing.addBill'];
    await page.getByRole('button', { name: addLabel, exact: true }).first().click();
    const add = page.getByRole('dialog', { name: addLabel });
    await add.getByRole('textbox', { name: view === 'bills' ? messages['bills.billName'] : messages['billing.billName'] }).fill('New synthetic bill');
    await add.getByRole('spinbutton', { name: view === 'bills' ? messages['bills.amount'] : messages['billing.amount'] }).fill('10');
    await add.getByLabel(view === 'bills' ? messages['bills.dueDate'] : messages['billing.dueDate']).fill('2026-01-31');
    await add.locator('button[type=submit]').click(); await expect.poll(() => proof.actual.writes.length).toBe(1);
    await add.getByRole('button', { name: messages['modal.closeDialog'], exact: true }).click();
    await page.getByRole('button', { name: addLabel, exact: true }).first().click();
    await add.getByRole('textbox', { name: view === 'bills' ? messages['bills.billName'] : messages['billing.billName'] }).fill('Keep this new draft');
    proof.actual.release(); await page.waitForTimeout(80); await expect(add).toBeVisible();
    await expect(add.getByRole('textbox', { name: view === 'bills' ? messages['bills.billName'] : messages['billing.billName'] })).toHaveValue('Keep this new draft');
    await expect(page.getByText('Bill added', { exact: true })).toHaveCount(0); expect(proof.actual.writes).toHaveLength(1); expect(proof.errors).toEqual([]);
  });
}
test('a pending account creation is retired on family/user switch and cannot resurrect', async ({ page }) => {
  const proof = await fixture(page, 'billing', 'held');
  await page.getByRole('button', { name: messages['billing.linkAccount'], exact: true }).click();
  const add = page.getByRole('dialog', { name: messages['billing.addAccount'] });
  await add.getByRole('textbox', { name: messages['billing.accountName'] }).fill('Synthetic bank');
  await add.getByRole('spinbutton', { name: messages['billing.currentBalance'] }).fill('1');
  await add.locator('button[type=submit]').click(); await expect.poll(() => proof.actual.writes.length).toBe(1);
  await page.evaluate(() => (window as unknown as { __schedule: { switch(owner: string, family: string): void } }).__schedule.switch('owner-b', 'other-family')); await expect(add).toHaveCount(0);
  await page.evaluate(family => (window as unknown as { __schedule: { switch(owner: string, family: string): void } }).__schedule.switch('owner-a', family), initial.family_id);
  proof.actual.release(); await page.waitForTimeout(80); await expect(add).toHaveCount(0); await expect(page.getByText(messages['billingModule.accountAdded'], { exact: true })).toHaveCount(0); expect(proof.errors).toEqual([]);
});
test('owner and family ABA dismiss a held repair and discard its late response', async ({ page }) => {
  const proof = await fixture(page, 'bills', 'held'); await choose(page);
  await dialog(page).getByRole('button', { name: 'Save schedule' }).click();
  await expect.poll(() => proof.actual.writes.length).toBe(1);
  await page.evaluate(() => (window as unknown as { __schedule: { switch(owner: string, family: string): void } }).__schedule.switch('owner-b', 'other-family'));
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(family => (window as unknown as { __schedule: { switch(owner: string, family: string): void } }).__schedule.switch('owner-a', family), initial.family_id);
  proof.actual.release();
  await expect.poll(() => proof.actual.paths.length).toBe(3);
  await expect(dialog(page)).toHaveCount(0); await expect(page.getByText('Bill schedule saved.', { exact: true })).toHaveCount(0);
  expect(proof.actual.row()).toMatchObject({ due_date: initial.due_date, status: initial.status }); expect(proof.errors).toEqual([]);
});
for (const view of ['bills', 'billing'] as const) test(`${view} close/reopen keeps a new modal instance safe from an old pending save`, async ({ page }) => {
  const proof = await fixture(page, view, 'held'); await choose(page);
  await dialog(page).getByRole('button', { name: 'Save schedule' }).click();
  await expect.poll(() => proof.actual.writes.length).toBe(1);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit schedule', exact: true }).first().click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('combobox', { name: 'Day of month' })).toHaveValue('');
  proof.actual.release();
  await expect.poll(() => proof.actual.paths.length).toBe(3);
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByText('Bill schedule saved.', { exact: true })).toHaveCount(0);
  expect(proof.actual.writes).toHaveLength(1); expect(proof.errors).toEqual([]);
});
