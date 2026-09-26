import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import type { QueryRefreshConfirmation } from '@/lib/hooks/use-realtime-query';

// Actual React, query hook and cache invalidation; deterministic asynchronous
// fetch boundaries isolate commit ordering from provider/network latency.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries(['lib/hooks/use-realtime-query.ts', 'lib/offline/cache.ts'].map(file => [
  `@/${file.replace(/\.ts$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
]));
type Snapshot = { rows: string[]; error: string | null; stale: boolean };
type ConfirmationProbe = {
  mount: (family?: string) => void; unmount: () => void;
  confirm: () => Promise<void>; refresh: () => Promise<void>;
  settle: (request: number, error?: boolean) => void;
  setData: () => void; purge: () => void; count: number;
  results: Array<{ result: QueryRefreshConfirmation; committed: Snapshot | null }>;
};
declare global { interface Window { __queryConfirmation: ConfirmationProbe } }

async function fixture(page: Page) {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  await page.goto('https://query-confirmation.invalid');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {}, requests = [];
    const mocks = { react: React, '@/lib/supabase/client': { createClient: () => ({}) },
      '@/lib/supabase/errors': { describeDbError: error => error.message },
      '@/lib/offline/cache-scope': { useAuthenticatedCacheScope: () => null, isAuthenticatedCacheScopeCurrent: () => true },
      '@/lib/realtime/published-tables': { realtimeChannelFor: () => null } };
    function load(id) { if (mocks[id]) return mocks[id]; if (modules[id]) return modules[id];
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports); return module.exports; }
    const hook = load('@/lib/hooks/use-realtime-query'), cache = load('@/lib/offline/cache');
    const p = window.__queryConfirmation = { results: [], count: 0 };
    function Query({ family }) {
      const query = hook.useRealtimeQuery({ table: 'medication_doses', familyId: family,
        fetcher: () => new Promise(resolve => { requests.push(resolve); p.count = requests.length; }) });
      p.confirm = async () => { const result = await query.refreshAndConfirm();
        p.results.push({ result, committed: document.getElementById('snapshot') ? JSON.parse(document.getElementById('snapshot').textContent) : null }); };
      p.refresh = query.refresh; p.setData = () => query.setData([{ id: 'local' }]);
      return React.createElement('pre', { id: 'snapshot' }, JSON.stringify({ rows: query.data.map(row => row.id), error: query.error, stale: query.stale }));
    }
    let root;
    p.mount = (family = 'family-a') => { root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(Query, { family }))); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.settle = (request, error = false) => requests[request]({ data: error ? null : [{ id: 'row-' + request }], error: error ? { message: 'Read failed' } : null });
    p.purge = () => cache.clearAllCache();
    p.mount();
  })();` });
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.count)).toBe(1);
  await page.evaluate(() => window.__queryConfirmation.settle(0));
  await expect(page.locator('#snapshot')).toContainText('row-0');
}
async function confirm(page: Page) {
  await page.evaluate(() => { void window.__queryConfirmation.confirm(); });
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.count)).toBe(2);
}

test('confirmation resolves after usable latest rows commit, while ordinary refresh keeps its API', async ({ page }) => {
  await fixture(page); await confirm(page);
  await page.evaluate(() => { void window.__queryConfirmation.refresh(); });
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.count)).toBe(3);
  await page.evaluate(() => window.__queryConfirmation.settle(1));
  expect(await page.evaluate(() => window.__queryConfirmation.results)).toEqual([]);
  await page.evaluate(() => window.__queryConfirmation.settle(2));
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.results)).toEqual([
    { result: { ok: true }, committed: { rows: ['row-2'], error: null, stale: false } },
  ]);
});

test('a superseding read error cannot confirm the prior successful rows', async ({ page }) => {
  await fixture(page); await confirm(page);
  await page.evaluate(() => { void window.__queryConfirmation.refresh(); });
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.count)).toBe(3);
  await page.evaluate(() => { window.__queryConfirmation.settle(1); window.__queryConfirmation.settle(2, true); });
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.results)).toEqual([
    { result: { ok: false, reason: 'error', error: 'Read failed' }, committed: { rows: ['row-0'], error: 'Read failed', stale: true } },
  ]);
});

for (const retirement of ['unmount', 'purge', 'family'] as const) test(`${retirement} retires pending confirmation without hanging or confirming late rows`, async ({ page }) => {
  await fixture(page); await confirm(page);
  await page.evaluate(retirement => {
    const p = window.__queryConfirmation;
    if (retirement === 'family') p.mount('family-b'); else p[retirement]();
  }, retirement);
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.results.map(item => item.result))).toEqual([{ ok: false, reason: 'inactive' }]);
  await page.evaluate(() => window.__queryConfirmation.settle(1));
  expect(await page.evaluate(() => window.__queryConfirmation.results.map(item => item.result))).toEqual([{ ok: false, reason: 'inactive' }]);
});

test('local setData cannot be mistaken for confirmed provider readback', async ({ page }) => {
  await fixture(page); await confirm(page);
  await page.evaluate(() => window.__queryConfirmation.setData());
  await expect.poll(() => page.evaluate(() => window.__queryConfirmation.results.map(item => item.result))).toEqual([{ ok: false, reason: 'superseded' }]);
  await expect(page.locator('#snapshot')).toContainText('local');
  await page.evaluate(() => window.__queryConfirmation.settle(1));
  await expect(page.locator('#snapshot')).toContainText('"stale":true');
});
