import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Only the next ordinary render is required. No background midnight timer,
// native authorization, food-safety or persistence qualification is claimed.
const origin = 'https://pantry-family-day.synthetic.invalid';
const familyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceRoot = process.cwd();
const { react, reactDom } = reactBrowserScripts();
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const seams = new Set(['react', 'react-dom', 'lucide-react', 'next/link', 'next/navigation', '@/components/app/app-context', '@/components/i18n/locale-provider', '@/components/ui/toast', '@/components/ai/ai-insight', '@/lib/supabase/client', '@/lib/offline/cache-scope', '@/app/(app)/dashboard/pantry/actions', '@/app/(app)/dashboard/grocery/actions']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, filename + '.ts', filename + '.tsx', path.join(filename, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? 'module.exports=' + raw : /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1]; item.imports[name] = seams.has(name) ? name : collect(name.startsWith('@/') ? path.join(sourceRoot, name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entry = collect(path.join(sourceRoot, 'components/modules/pantry-module.tsx'));
const zoned = collect(path.join(sourceRoot, 'lib/time/zoned.ts'));
const scenarios = [
  { name: 'New York midnight advances on the next public render while the UTC device day stays put', zone: 'America/New_York', before: '2026-10-24T03:59:00Z', after: '2026-10-24T04:01:00Z', initialFamilyDay: '2026-10-23', finalFamilyDay: '2026-10-24', initialDeviceDay: '2026-10-24', finalDeviceDay: '2026-10-24', expiry: '2026-10-23', changes: true },
  { name: 'UTC device midnight does not advance the New York family day', zone: 'America/New_York', before: '2026-10-23T23:59:00Z', after: '2026-10-24T00:01:00Z', initialFamilyDay: '2026-10-23', finalFamilyDay: '2026-10-23', initialDeviceDay: '2026-10-23', finalDeviceDay: '2026-10-24', expiry: '2026-10-23', changes: false },
  { name: 'a UTC family advances on the next public render after its midnight', zone: 'UTC', before: '2026-10-23T23:59:00Z', after: '2026-10-24T00:01:00Z', initialFamilyDay: '2026-10-23', finalFamilyDay: '2026-10-24', initialDeviceDay: '2026-10-23', finalDeviceDay: '2026-10-24', expiry: '2026-10-23', changes: true },
  { name: 'Tokyo midnight advances while the UTC device date remains unchanged', zone: 'Asia/Tokyo', before: '2026-10-23T14:59:00Z', after: '2026-10-23T15:01:00Z', initialFamilyDay: '2026-10-23', finalFamilyDay: '2026-10-24', initialDeviceDay: '2026-10-23', finalDeviceDay: '2026-10-23', expiry: '2026-10-23', changes: true },
  { name: 'New York repeated DST hour does not invent a new family day', zone: 'America/New_York', before: '2026-11-01T05:59:00Z', after: '2026-11-01T06:01:00Z', initialFamilyDay: '2026-11-01', finalFamilyDay: '2026-11-01', initialDeviceDay: '2026-11-01', finalDeviceDay: '2026-11-01', expiry: '2026-11-01', changes: false },
  { name: 'an item with no expiry keeps no date badge and no expired count across midnight', zone: 'America/New_York', before: '2026-10-24T03:59:00Z', after: '2026-10-24T04:01:00Z', initialFamilyDay: '2026-10-23', finalFamilyDay: '2026-10-24', initialDeviceDay: '2026-10-24', finalDeviceDay: '2026-10-24', expiry: null, changes: false },
] as const;
type Scenario = typeof scenarios[number];
const errors = new WeakMap<Page, string[]>();
test.use({ timezoneId: 'UTC', locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async ({ page }) => { const faults: string[] = []; errors.set(page, faults); page.on('pageerror', e => faults.push(e.message)); page.on('requestfailed', r => faults.push(r.url())); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); expect(await page.evaluate(() => (window as any).__pantryDay?.errors ?? [])).toEqual([]); });
const opener = (page: Page) => page.getByRole('heading', { level: 1 }).locator('..').locator('..').getByRole('button', { name: messages['pantry.addItem'], exact: true });
const expiredCount = (page: Page) => page.locator('.stat-card').filter({ has: page.getByText(messages['pantryModule.stat.expired'], { exact: true }) }).locator('.text-xl');

async function mount(page: Page, scenario: Scenario) {
  const rows = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', family_id: familyId, name: 'Family day milk', quantity: 10, unit: 'bottles', low_threshold: 1, is_staple: false, location: 'fridge', category: 'Dairy & Eggs', expires_at: scenario.expiry, notes: null }];
  const initialRows = structuredClone(rows), requests: { method: string; pathname: string; family: string | null }[] = [];
  await page.clock.install({ time: new Date(scenario.before) });
  await page.route('**/*', async route => { expect(route.request().url(), 'no external network').toBe(origin + '/'); await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); });
  await page.exposeFunction('__pantryDayFetch', async (url: string, method: string) => {
    const parsed = new URL(url); requests.push({ method, pathname: parsed.pathname, family: parsed.searchParams.get('family_id') });
    expect(parsed.origin).toBe(origin); expect(method).toBe('GET'); expect(parsed.pathname).toBe('/rest/v1/pantry_items'); expect(parsed.searchParams.get('family_id')).toBe('eq.' + familyId);
    return structuredClone(rows);
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk, 'window.react=window.React;', icons]) await page.addScriptTag({ content });
  await page.evaluate(({ sources, entry, zoned, familyId, origin, messages, zone }) => {
    const w = window as any, R = w.React, D = w.ReactDOM;
    const p: { errors: string[]; actions: string[]; notices: string[]; consumedReads: number; clock?: () => { instant: string; deviceZone: string; familyDay: string; deviceDay: string } } = w.__pantryDay = { errors: [] as string[], actions: [] as string[], notices: [] as string[], consumedReads: 0 };
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const client = w.supabase.createClient(origin, 'synthetic-not-a-secret', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url: any, init: any) => {
      const body = await w.__pantryDayFetch(String(url), init?.method ?? 'GET');
      const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      const text = response.text.bind(response); response.text = async () => { const value = await text(); p.consumedReads++; return value; }; return response;
    } } });
    // Query/storage builders are untouched; no remote Realtime subscription exists.
    const db = new Proxy(client, { get(target, property) { if (property === 'channel') return () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe: async () => {} }); if (property === 'removeChannel') return async () => {}; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    const action = (name: string) => async () => { p.actions.push(name); throw new Error('No write action belongs to this date-render fixture'); };
    const tr = (key: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((s, [key, value]) => s.split('{' + key + '}').join(String(value)), messages[key] ?? key);
    const mocks: Record<string, any> = {
      react: R, 'react-dom': D, 'lucide-react': w.LucideReact,
      'next/link': { default: (props: any) => R.createElement('a', props, props.children) }, 'next/navigation': { useRouter: () => ({}) },
      '@/components/app/app-context': { useApp: () => ({ familyId, userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', family: { id: familyId, timezone: zone }, role: 'parent', members: [] }) },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => zone },
      '@/components/ui/toast': { useToast: () => ({ success: (s: string) => p.notices.push(s), error: (s: string) => p.errors.push(s) }) }, '@/components/ai/ai-insight': { AiInsight: () => null },
      '@/lib/supabase/client': { createClient: () => db }, '@/lib/offline/cache-scope': { useAuthenticatedCacheScope: () => null, isAuthenticatedCacheScopeCurrent: () => true },
      '@/app/(app)/dashboard/pantry/actions': { adjustPantryQuantityAction: action('adjust'), removePantryItemAction: action('remove'), savePantryItemAction: action('save') },
      '@/app/(app)/dashboard/grocery/actions': { addGroceryItemsAction: action('grocery') },
    };
    const cache: Record<string, any> = {};
    function load(id: string): any { if (id in mocks) return mocks[id]; if (cache[id]) return cache[id].exports; const item = sources[id]; if (!item) throw new Error('Missing source ' + id); const compiled = cache[id] = { exports: {} }; new Function('require', 'module', 'exports', item.source)((name: string) => load(item.imports[name]), compiled, compiled.exports); return compiled.exports; }
    p.clock = () => ({ instant: new Date().toISOString(), deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone, familyDay: load(zoned).dayKeyIn(new Date(), zone), deviceDay: load(zoned).dayKeyIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone) });
    D.createRoot(document.getElementById('root')).render(R.createElement(load(entry).PantryModule));
  }, { sources: modules, entry, zoned, familyId, origin, messages, zone: scenario.zone });
  await expect.poll(() => page.evaluate(() => (window as any).__pantryDay.consumedReads)).toBe(1);
  await expect(opener(page)).toBeVisible(); await expect(expiredCount(page)).toHaveText('0');
  return { rows, initialRows, requests };
}

for (const scenario of scenarios) test(scenario.name, async ({ page }, info) => {
  const proof = await mount(page, scenario);
  const observations: unknown[] = [];
  try {
    const before = await page.evaluate(() => (window as any).__pantryDay.clock()); observations.push(before);
    expect(before).toMatchObject({ deviceZone: 'UTC', familyDay: scenario.initialFamilyDay, deviceDay: scenario.initialDeviceDay });
    if (scenario.expiry) await expect(page.getByText('Expires today', { exact: true })).toHaveCount(2);
    else await expect(page.getByText(/^(?:Expires |Expired )/)).toHaveCount(0);
    await page.clock.setSystemTime(new Date(scenario.after));
    const after = await page.evaluate(() => (window as any).__pantryDay.clock()); observations.push(after);
    expect(after).toMatchObject({ deviceZone: 'UTC', familyDay: scenario.finalFamilyDay, deviceDay: scenario.finalDeviceDay });
    // Public state changes only: opening/closing the actual modal causes normal renders.
    await opener(page).click(); await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: messages['pantry.cancel'], exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(opener(page)).toBeFocused();
    expect(proof.requests.length).toBeGreaterThan(0); expect(proof.requests.every(r => r.method === 'GET' && r.family === 'eq.' + familyId)).toBe(true);
    expect(proof.rows).toEqual(proof.initialRows);
    expect(await page.evaluate(() => (window as any).__pantryDay.actions)).toEqual([]);
    if (scenario.expiry) {
      // Synchronous desired assertions follow two observed completed public renders.
      const badge = scenario.changes ? 'Expired yesterday' : 'Expires today';
      const actual = await page.getByText(badge, { exact: true }).count();
      expect(actual, JSON.stringify({ scenario, before, after, requestedBadge: badge, rendered: await page.locator('.module-page').innerText() })).toBe(2);
    } else await expect(page.getByText(/^(?:Expires |Expired )/)).toHaveCount(0);
    await expect(expiredCount(page)).toHaveText(scenario.changes ? '1' : '0');
  } finally {
    await info.attach('pantry-family-day-readonly-observation', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ scenario, observations, rows: proof.rows, initialRows: proof.initialRows, requests: proof.requests, runtime: await page.evaluate(() => ({ clock: (window as any).__pantryDay.clock(), actions: (window as any).__pantryDay.actions, errors: (window as any).__pantryDay.errors, consumedReads: (window as any).__pantryDay.consumedReads })), rendered: await page.locator('.module-page').innerText() }, null, 2)) });
  }
});
