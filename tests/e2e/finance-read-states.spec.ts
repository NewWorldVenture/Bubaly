import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from '@playwright/test';

// Actual finance views, calculations and shared state/button components in
// Chromium. The query-result boundary is controlled; no financial writes occur.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries([
  ...['budgets', 'bills', 'payments', 'savings'].map(name => `components/finance/${name}-view.tsx`),
  'components/ui/states.tsx', 'components/ui/states-client.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/app/page-header.tsx', 'lib/finance/hub.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText]));

type QueryResult = { data: Record<string, unknown>[]; loading: boolean; error: string | null; stale?: boolean };
type View = 'budgets' | 'bills' | 'payments' | 'savings';
declare global {
  interface Window {
    __financeReads: {
      mount: (view: View, mode?: string) => void;
      set: (table: string, result: QueryResult) => void;
      replies: Record<string, QueryResult>;
      retries: string[];
      errors: string[];
    };
  }
}

const budget = { id: 'budget', category: 'Groceries', amount: 500, period: 'monthly' };
const failed = (data: Record<string, unknown>[] = []): QueryResult => ({ data, loading: false, error: 'Fixture read unavailable', stale: true });
const loaded = (data: Record<string, unknown>[] = []): QueryResult => ({ data, loading: false, error: null });

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }));
  await page.goto('https://finance-reads-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const state = {}, listeners = new Set();
    const p = window.__financeReads = { replies: {}, retries: [], errors: [] };
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => p.errors.push(String(e.reason)));
    p.set = (table, result) => { state[table] = result; for (const listener of listeners) listener(); };
    const mocks = {
      react: React,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(v => typeof v === 'string').join(' ') },
      '@/components/app/app-context': { useApp: () => ({ familyId: 'family', userId: 'user' }) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => key === 'states.tryAgain' ? 'Try again' : key },
      '@/components/ui/toast': { useToast: () => ({ success() {}, error() {} }) },
      '@/components/ui/modal': { Modal: () => { throw new Error('Unexpected form write workflow'); } },
      '@/lib/supabase/client': { createClient: () => { throw new Error('Unexpected financial write'); } },
      '@/app/(app)/dashboard/billing/actions': {},
      '@/lib/hooks/use-realtime-query': { useRealtimeQuery: ({ table }) => {
        state[table] ??= { data: [], loading: false, error: null };
        const result = React.useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => state[table]);
        return { ...result, refresh: async () => { p.retries.push(table); if (p.replies[table]) p.set(table, p.replies[table]); } };
      } },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    let root;
    p.mount = (view, mode = 'all') => {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      const name = view[0].toUpperCase() + view.slice(1) + 'View';
      ReactDOM.flushSync(() => root.render(React.createElement(load('@/components/finance/' + view + '-view')[name], { mode })));
    };
  })();` });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__financeReads.errors)).toEqual([]);
});

for (const [view, table, mode, empty] of [
  ['budgets', 'budgets', 'all', 'budgets.noBudgetsYet'],
  ['bills', 'bills', 'all', 'No bills yet'],
  ['bills', 'bills', 'due', 'Nothing due'],
  ['bills', 'bills', 'autopay', 'No Auto Pay bills'],
  ['savings', 'savings_goals', 'all', 'savings.noSavingsGoals'],
  ['payments', 'transactions', 'all', 'payments.noPayments'],
] as const) {
  test(`${view} ${mode} reports a failed read and retries to a verified empty result`, async ({ page }) => {
    await page.evaluate(({ view, table, mode, result }) => { window.__financeReads.set(table, result); window.__financeReads.mount(view, mode); }, { view, table, mode, result: failed() });
    await expect(page.getByText('Fixture read unavailable')).toBeVisible({ timeout: 1500 });
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
    if (view === 'payments') await expect(page.locator('.stat-card')).toHaveCount(0);
    await page.evaluate(({ table, result }) => { window.__financeReads.replies[table] = result; }, { table, result: loaded() });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__financeReads.retries)).toContain(table);
  });
}

for (const failure of [false, true]) {
  test(`budget transaction ${failure ? 'failure' : 'loading'} never implies zero spending`, async ({ page }) => {
    await page.evaluate(({ budget, failure }) => {
      window.__financeReads.set('budgets', { data: [budget], loading: false, error: null });
      window.__financeReads.set('transactions', { data: [], loading: !failure, error: failure ? 'Fixture read unavailable' : null });
      window.__financeReads.mount('budgets');
    }, { budget, failure });
    await expect(page.getByText('$500.00 left', { exact: true })).toHaveCount(0);
    await expect(page.getByText('$0.00', { exact: true })).toHaveCount(0);
    if (failure) {
      await expect(page.getByText('Fixture read unavailable')).toBeVisible();
      await page.evaluate(result => { window.__financeReads.replies.transactions = result; }, loaded());
      await page.getByRole('button', { name: 'Try again' }).click();
      expect(await page.evaluate(() => window.__financeReads.retries)).toEqual(['budgets', 'transactions']);
    } else await page.evaluate(result => window.__financeReads.set('transactions', result), loaded());
    await expect(page.getByText('$500.00 left', { exact: true })).toBeVisible();
  });
}

test('payment summaries wait for the first successful transaction read', async ({ page }) => {
  await page.evaluate(() => { window.__financeReads.set('transactions', { data: [], loading: true, error: null }); window.__financeReads.mount('payments'); });
  await expect(page.locator('.stat-card')).toHaveCount(0);
  await page.evaluate(result => window.__financeReads.set('transactions', result), loaded());
  await expect(page.locator('.stat-card')).toHaveCount(4);
});

for (const [view, table, row] of [
  ['budgets', 'budgets', budget],
  ['bills', 'bills', { id: 'bill', name: 'Saved bill', amount: 22, due_date: '2026-09-15', status: 'upcoming' }],
  ['savings', 'savings_goals', { id: 'goal', name: 'Saved goal', current_amount: 5, target_amount: 50 }],
  ['payments', 'transactions', { id: 'txn', name: 'Saved payment', amount: 75, type: 'expense', date: '2026-09-12', status: 'completed' }],
] as const) {
  test(`${view} waits for revalidation before treating saved cache as current balances`, async ({ page }) => {
    await page.evaluate(({ view, table, row }) => {
      window.__financeReads.set(table, { data: [row], loading: false, error: null, stale: true });
      window.__financeReads.mount(view);
    }, { view, table, row });
    await expect(page.getByText(/\$\d/)).toHaveCount(0);
    await page.evaluate(({ table, row }) => window.__financeReads.set(table, { data: [row], loading: false, error: null, stale: false }), { table, row });
    await expect(page.getByText(/\$\d/).first()).toBeVisible();
  });
}

test('failed payment refresh hides unverified totals and preserves search through retry', async ({ page }) => {
  const row = { id: 'txn', name: 'Groceries', amount: 75, type: 'expense', category: 'Groceries', date: new Date().toISOString().slice(0, 10), status: 'completed' };
  await page.evaluate(result => { window.__financeReads.set('transactions', result); window.__financeReads.mount('payments'); }, loaded([row]));
  await page.getByPlaceholder('payments.searchPayments').fill('Groceries');
  await expect(page.getByText('Groceries', { exact: true })).toBeVisible();
  await page.evaluate(result => window.__financeReads.set('transactions', result), failed([row]));
  await expect(page.locator('.stat-card')).toHaveCount(0);
  await page.evaluate(result => { window.__financeReads.replies.transactions = result; }, loaded([row]));
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByPlaceholder('payments.searchPayments')).toHaveValue('Groceries');
  await expect(page.locator('.stat-card')).toHaveCount(4);
  await expect(page.getByText('Groceries', { exact: true })).toBeVisible();
});
