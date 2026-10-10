import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import type { Tables } from '@/lib/database.types';
import { reactBrowserScripts } from './helpers/react-browser';

// Mount the actual modal, scheduling/payment helpers and shared dialog/field/
// button/toast components. Only the family clock, locale and external adapters
// are controlled. The real Supabase SDK sends intercepted synthetic PATCHes;
// no app server, login, hosted database or provider is involved.
const origin = 'https://recurring-bill-payment-fixture.invalid';
const familyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const billId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const { react, reactDom } = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(
  path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js',
), 'utf8');
const messages: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const sources = Object.fromEntries([
  'components/finance/bill-payment-modal.tsx', 'components/ui/modal.tsx',
  'components/ui/input.tsx', 'components/ui/button.tsx', 'components/ui/toast.tsx', 'lib/hooks/use-media-query.ts',
  'lib/a11y/use-dialog-behavior.ts', 'lib/finance/hub.ts',
  'lib/finance/bill-schedule.ts', 'lib/finance/recurring.ts', 'lib/finance/bills.ts', 'lib/supabase/errors.ts',
  // The shared bills reader loads the actual counted reader and its closed graph.
  'lib/calendar/occurrences.ts', 'lib/calendar/recurrence.ts', 'lib/calendar/day.ts',
  'lib/calendar/source-capability.ts', 'lib/calendar/exact-instant.ts', 'lib/onboarding/ics-time.ts', 'lib/briefing/calendar-window.ts', 'lib/time/zoned.ts',
  'lib/i18n/locales.ts', 'lib/time/local-day.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText]));

type Bill = Tables<'bills'>;
type Outcome = 'saved' | 'stale' | 'missing-column' | 'missing-cache' | 'held';
type Mutation = { url: string; body: Record<string, unknown>; prefer: string | undefined };
declare global {
  interface Window {
    __billPayment: { done: number; closed: number; reactVersion: string };
  }
}

const bill = (over: Partial<Bill> = {}): Bill => ({
  id: billId, family_id: familyId, name: 'Synthetic rent', amount: 100,
  due_date: '2026-03-28', due_day: null, is_recurring: true, recurrence: 'monthly',
  status: 'upcoming', category: null, autopay: false, created_by: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T10:00:00Z', ...over,
});

async function fixture(page: Page, rendered = bill(), outcome: Outcome = 'saved') {
  const diagnostics: string[] = [];
  const expectedHttpErrors: string[] = [];
  const mutations: Mutation[] = [];
  const otherFamily = bill({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', family_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const otherBill = bill({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  const rows = [
    { ...rendered, ...(outcome === 'stale' ? { updated_at: '2026-03-28T12:00:00Z' } : {}) },
    otherFamily, otherBill,
  ];
  const before = structuredClone(rows);
  let settled = 0;
  let release: (() => void) | undefined;
  page.on('pageerror', error => diagnostics.push(error.message));
  page.on('console', message => {
    if ((outcome === 'missing-column' || outcome === 'missing-cache')
      && message.type() === 'error'
      && message.text() === 'Failed to load resource: the server responded with a status of 400 (Bad Request)'
      && message.location().url.startsWith(origin + '/rest/v1/bills?')) {
      expectedHttpErrors.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(message.type() + ': ' + message.text());
    }
  });
  page.on('requestfailed', request => diagnostics.push('Failed browser request: ' + request.url()));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'PATCH, OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'apikey, authorization, content-type, prefer, x-client-info',
    };
    if (url.origin !== origin || url.pathname !== '/rest/v1/bills') {
      diagnostics.push('Unexpected browser request: ' + request.method() + ' ' + request.url());
      await route.abort(); return;
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers }); return;
    }
    if (request.method() !== 'PATCH') {
      diagnostics.push('Unexpected database operation: ' + request.method());
      await route.abort(); return;
    }
    const patch = request.postDataJSON() as Record<string, unknown>;
    mutations.push({ url: url.href, body: patch, prefer: request.headers().prefer });
    if (outcome === 'held') await new Promise<void>(resolve => { release = resolve; });
    let status = 200;
    let body: unknown;
    if (outcome === 'missing-column' || outcome === 'missing-cache') {
      status = 400;
      body = outcome === 'missing-column'
        ? { code: '42703', message: 'column bills.due_day does not exist' }
        : { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" };
    } else {
      const matching = rows.filter(row => [...url.searchParams].every(([column, predicate]) => {
        if (column === 'select') return true;
        const value = row[column as keyof Bill];
        return predicate === 'is.null' ? value === null : predicate === `eq.${String(value)}`;
      }));
      for (const row of matching) Object.assign(row, patch);
      body = matching.map(row => ({ id: row.id }));
    }
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    settled++;
  });
  await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const React = window.React, sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, cache = {};
    const p = window.__billPayment = { done: 0, closed: 0, reactVersion: React.version };
    const sb = window.supabase.createClient(${JSON.stringify(origin)}, 'synthetic-not-a-secret', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const tr = key => messages[key] || key;
    const mocks = {
      react: React, 'react-dom': window.ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, usePlural: () => (key, count) => tr(key + (count === 1 ? '.one' : '.other')).replace('{count}', String(count)) },
      '@/components/i18n/use-format': { useFamilyClock: () => ({ todayKey: () => '2026-03-28' }) },
      '@/lib/supabase/client': { createClient: () => sb },
      '@capacitor/core': { Capacitor: { isNativePlatform: () => false } },
    };
    function load(name) {
      if (name in mocks) return mocks[name];
      if (name in cache) return cache[name].exports;
      if (!(name in sources)) throw new Error('Unexpected bill-payment fixture module: ' + name);
      const module = { exports: {} }; cache[name] = module;
      const localRequire = child => load(child === '../onboarding/ics-time' ? '@/lib/onboarding/ics-time' : child === '../calendar/exact-instant' ? '@/lib/calendar/exact-instant' : child === '../time/zoned' ? '@/lib/time/zoned' : child.startsWith('.') ? name.slice(0, name.lastIndexOf('/') + 1) + child.slice(2) : child);
      new Function('require', 'module', 'exports', 'React', sources[name])(localRequire, module, module.exports, React);
      return module.exports;
    }
    const Payment = load('@/components/finance/bill-payment-modal').BillPaymentModal;
    const ToastProvider = load('@/components/ui/toast').ToastProvider;
    function Harness() {
      const [open, setOpen] = React.useState(true);
      const current = React.useRef(open); current.current = open;
      return React.createElement(ToastProvider, null, open && React.createElement(Payment, {
        bill: ${JSON.stringify(rendered)}, familyId: ${JSON.stringify(familyId)},
        isCurrent: () => current.current,
        onDone: () => { p.done++; }, onClose: () => { current.current = false; p.closed++; setOpen(false); },
      }));
    }
    const root = window.ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(Harness));
  })();` });
  await expect(page.getByRole('dialog', { name: 'Confirm bill schedule' })).toBeVisible();
  expect(await page.evaluate(() => window.__billPayment.reactVersion)).toMatch(/^19\./);
  return { rows, before, mutations, diagnostics, expectedHttpErrors, outcome, settled: () => settled, release: () => release?.() };
}

type Proof = Awaited<ReturnType<typeof fixture>>;
const markPaid = (page: Page) => page.getByRole('button', { name: 'Mark paid', exact: true });
const day = (page: Page) => page.getByRole('combobox', { name: 'Day of month' });
const cadence = (page: Page) => page.getByRole('combobox', { name: 'Recurrence' });
const patch = { status: 'upcoming', due_date: '2026-04-30', recurrence: 'monthly', due_day: 31 };

function exactMutation(proof: Proof, rendered: Bill) {
  expect(proof.mutations).toHaveLength(1);
  const mutation = proof.mutations[0];
  expect(mutation.body).toEqual(patch);
  expect(mutation.prefer).toContain('return=representation');
  expect(Object.fromEntries(new URL(mutation.url).searchParams)).toEqual({
    id: `eq.${billId}`, family_id: `eq.${familyId}`, updated_at: `eq.${rendered.updated_at}`,
    due_date: `eq.${rendered.due_date}`, status: 'eq.upcoming', is_recurring: 'eq.true',
    recurrence: rendered.recurrence === null ? 'is.null' : `eq.${rendered.recurrence}`, select: 'id',
    ...(rendered.due_day !== undefined ? {due_day: rendered.due_day === null ? 'is.null' : `eq.${rendered.due_day}`} : {}),
  });
}

// Owner decision 2026-10-09 (PR #982): while held migration 0488 is absent,
// recurring bills fall back to the previous production behaviour, and
// lib/finance/recurring.ts warns exactly once per page that bills.due_day is
// missing. That one warning is the only diagnostic either missing outcome may
// produce; every other outcome stays diagnostic-free.
const dueDayMissingWarning = 'warning: bills.due_day is not in this database yet (migration supabase/reserved/0488_a_month_end_bill_keeps_its_day.sql has not been applied); recurring bills step from their due date\'s own day, as they did before it, until it is.';

async function finish(page: Page, proof: Proof) {
  await expect.poll(proof.settled).toBe(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(proof.diagnostics).toEqual(proof.outcome === 'missing-column' || proof.outcome === 'missing-cache'
    ? [dueDayMissingWarning] : []);
  expect(proof.expectedHttpErrors).toEqual(proof.outcome === 'missing-column' || proof.outcome === 'missing-cache'
    ? ['Failed to load resource: the server responded with a status of 400 (Bad Request)'] : []);
}

for (const dueDate of ['2026-03-28', '2026-03-29', '2026-03-30']) {
  test('legacy ' + dueDate + ' requires owner day confirmation and preserves day31 through April', async ({ page }) => {
    const rendered = bill({ due_date: dueDate });
    const proof = await fixture(page, rendered);
    await expect(day(page)).toHaveValue('');
    await expect(markPaid(page)).toBeDisabled();
    await markPaid(page).evaluate(button => (button as HTMLButtonElement).click());
    expect(proof.mutations).toEqual([]);
    await cadence(page).selectOption('monthly');
    await day(page).selectOption('31');
    await expect(markPaid(page)).toBeEnabled();
    await markPaid(page).click();
    await finish(page, proof);
    exactMutation(proof, rendered);
    expect(proof.rows[0]).toEqual({ ...rendered, ...patch });
    expect(proof.rows.slice(1)).toEqual(proof.before.slice(1));
    await expect(page.getByRole('status')).toContainText('Bill marked as paid');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.__billPayment)).toMatchObject({ done: 1, closed: 1 });
  });
}

test('unknown cadence stays unselected until the owner chooses monthly and day31', async ({ page }) => {
  const rendered = bill({ recurrence: null });
  const proof = await fixture(page, rendered);
  await expect(cadence(page)).toHaveValue('');
  await expect(day(page)).toHaveCount(0);
  await expect(markPaid(page)).toBeDisabled();
  await cadence(page).selectOption('monthly');
  await expect(day(page)).toHaveValue('');
  await expect(markPaid(page)).toBeDisabled();
  await day(page).selectOption('31');
  await markPaid(page).click();
  await finish(page, proof);
  exactMutation(proof, rendered);
  expect(proof.rows[0]).toEqual({ ...rendered, ...patch });
  await expect(page.getByRole('status')).toContainText('Bill marked as paid');
});

test('a stale occurrence returns zero rows, shows an error and never reports payment success', async ({ page }) => {
  const rendered = bill();
  const proof = await fixture(page, rendered, 'stale');
  await day(page).selectOption('31');
  await markPaid(page).click();
  await finish(page, proof);
  exactMutation(proof, rendered);
  expect(proof.rows).toEqual(proof.before);
  await expect(page.getByRole('alert')).toContainText(messages['errors.thatChangeWasNotSaved']);
  await expect(page.getByRole('status')).toHaveCount(0);
  // The existing UI refreshes/closes after a stale CAS; this is not a success.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__billPayment)).toMatchObject({ done: 1, closed: 1 });
});

// Owner decision 2026-10-09 (PR #982) replaced "refuse until 0488 lands" with
// the pre-0488 fallback. On the exact missing bills.due_day answer the
// fallback warns once and drops due_day; it retries through the same CAS only
// when the due date itself carries the day. Day 31 rolling to Apr 30 is a day
// only the column could keep, and this modal passes no confirmClampedDay, so
// the fallback refuses (DueDayNotKept) before any second write: one PATCH,
// the "not available yet" alert, and the row as it was.
for (const outcome of ['missing-column', 'missing-cache'] as const) {
  test(outcome + ' warns once that due_day is missing and keeps a day-31 bill unchanged without a second write', async ({ page }) => {
    const rendered = bill();
    const proof = await fixture(page, rendered, outcome);
    await day(page).selectOption('31');
    await markPaid(page).click();
    await finish(page, proof);
    exactMutation(proof, rendered);
    expect(proof.rows).toEqual(proof.before);
    await expect(page.getByRole('alert')).toContainText(messages['bills.scheduleUnavailable']);
    await expect(page.getByRole('alert')).not.toContainText('due_day');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(day(page)).toHaveValue('31');
    await expect(markPaid(page)).toBeEnabled();
    expect(await page.evaluate(() => window.__billPayment)).toMatchObject({ done: 0, closed: 0 });
    // Once the refusal is on screen: still the single PATCH (no retry without
    // due_day) and still exactly the one missing-column warning.
    exactMutation(proof, rendered);
    expect(proof.diagnostics).toEqual([dueDayMissingWarning]);
  });
}

test('pending payment disables repeated clicks until its one CAS completes', async ({ page }) => {
  const rendered = bill();
  const proof = await fixture(page, rendered, 'held');
  await day(page).selectOption('31');
  await markPaid(page).click();
  await expect.poll(() => proof.mutations.length).toBe(1);
  await expect(markPaid(page)).toBeDisabled();
  await markPaid(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  expect(proof.mutations).toHaveLength(1);
  proof.release();
  await finish(page, proof);
  exactMutation(proof, rendered);
  await expect(page.getByRole('status')).toContainText('Bill marked as paid');
});

test('cancelling an unsubmitted confirmation makes no database request', async ({ page }) => {
  const proof = await fixture(page);
  await day(page).selectOption('31');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(proof.mutations).toEqual([]);
  expect(proof.rows).toEqual(proof.before);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(await page.evaluate(() => window.__billPayment)).toMatchObject({ done: 0, closed: 1 });
  expect(proof.diagnostics).toEqual([]);
});
