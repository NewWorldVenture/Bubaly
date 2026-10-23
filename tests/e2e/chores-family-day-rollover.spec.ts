import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Next ordinary public tab render only. Actual module/clock/query/SDK reads;
// no idle midnight timer, reward action, native authorization or provider runs.
const origin = 'https://chores-family-day.synthetic.invalid';
const familyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const memberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sourceRoot = process.cwd();
const { react, reactDom } = reactBrowserScripts();
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const seams = new Set(['react', 'react-dom', 'lucide-react', 'next/link', 'next/navigation', '@/components/app/app-context', '@/components/i18n/locale-provider', '@/components/ui/toast', '@/lib/supabase/client', '@/lib/offline/cache-scope', '@/app/(app)/dashboard/chores/actions', '@/app/(app)/wallet/actions', '@/app/(app)/dashboard/rewards/actions']);
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
const entry = collect(path.join(sourceRoot, 'components/modules/chores-module.tsx'));
const zoned = collect(path.join(sourceRoot, 'lib/time/zoned.ts'));
const scenarios = [
  { name: 'UTC device midnight preserves a New York family streak on an ordinary tab render', zone: 'America/New_York', before: '2026-10-23T23:59:00Z', after: '2026-10-24T00:01:00Z', approved: '2026-10-22T16:00:00Z', beforeDay: '2026-10-23', afterDay: '2026-10-23', initialStreak: 1, finalStreak: 1, initialPoints: 10, finalPoints: 10, period: 'week' },
  { name: 'a fresh mount after family midnight shows an already lapsed streak', zone: 'America/New_York', before: '2026-10-24T04:00:01Z', after: '2026-10-24T04:01:00Z', approved: '2026-10-22T16:00:00Z', beforeDay: '2026-10-24', afterDay: '2026-10-24', initialStreak: 0, finalStreak: 0, initialPoints: 10, finalPoints: 10, period: 'week' },
  { name: 'the New York repeated DST hour preserves current-day streak and points', zone: 'America/New_York', before: '2026-11-01T05:59:00Z', after: '2026-11-01T06:01:00Z', approved: '2026-10-31T16:00:00Z', beforeDay: '2026-11-01', afterDay: '2026-11-01', initialStreak: 1, finalStreak: 1, initialPoints: 10, finalPoints: 10, period: 'week' },
  { name: 'all-time points survive family midnight and an ordinary tab render', zone: 'America/New_York', before: '2026-10-24T03:59:00Z', after: '2026-10-24T04:00:01Z', approved: '2026-10-16T16:00:00Z', beforeDay: '2026-10-23', afterDay: '2026-10-24', initialStreak: 0, finalStreak: 0, initialPoints: 10, finalPoints: 10, period: 'all' },
  { name: 'a streak that lapses at family midnight disappears on the next public tab render', zone: 'America/New_York', before: '2026-10-24T03:59:00Z', after: '2026-10-24T04:00:01Z', approved: '2026-10-22T16:00:00Z', beforeDay: '2026-10-23', afterDay: '2026-10-24', initialStreak: 1, finalStreak: 0, initialPoints: 10, finalPoints: 10, period: 'week' },
  { name: 'weekly points age out at family midnight on the next public tab render', zone: 'America/New_York', before: '2026-10-24T03:59:00Z', after: '2026-10-24T04:00:01Z', approved: '2026-10-16T16:00:00Z', beforeDay: '2026-10-23', afterDay: '2026-10-24', initialStreak: 0, finalStreak: 0, initialPoints: 10, finalPoints: 0, period: 'week' },
] as const;
type Scenario = typeof scenarios[number];
const errors = new WeakMap<Page, string[]>();
test.use({ timezoneId: 'UTC', locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(async ({ page }) => { const faults: string[] = []; errors.set(page, faults); page.on('pageerror', e => faults.push(e.message)); page.on('requestfailed', r => faults.push(r.url())); });
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); expect(await page.evaluate(() => (window as any).__choreDay?.errors ?? [])).toEqual([]); });
const streakCard = (page: Page) => page.locator('.sidebar-card').filter({ has: page.getByText(messages['chores.choreStreaks'], { exact: true }) });
const pointsCard = (page: Page) => page.locator('.sidebar-card').filter({ has: page.getByText(messages['chores.familyChorePoints'], { exact: true }) });
const streakValue = (page: Page) => streakCard(page).locator('.text-orange-400').filter({ hasText: /^\d+ days?$/ });
const pointsValue = (page: Page) => pointsCard(page).locator('.text-4xl');
async function drainRender(page: Page) {
  await page.evaluate(async () => {
    const turn = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
    await turn(); await turn();
    (window as any).ReactDOM.flushSync(() => {});
  });
}
async function mount(page: Page, scenario: Scenario) {
  const rows: Record<string, Record<string, unknown>[]> = {
    chore_assignments: [{ id: 'assignment-one', family_id: familyId, chore_id: 'chore-one', member_id: memberId, status: 'approved', due_at: null, submitted_at: scenario.approved, approved_at: scenario.approved, approved_by: memberId, points_awarded: 10, created_at: scenario.approved }],
    chores: [{ id: 'chore-one', family_id: familyId, title: 'Synthetic completed chore', description: null, points: 10, recurrence: 'none', icon: null, category: null, created_at: scenario.approved }], rewards: [],
  };
  const initialRows = structuredClone(rows), requests: { method: string; pathname: string; family: string | null; query: string }[] = [];
  try {
  await page.clock.install({ time: new Date(scenario.before) });
  await page.route('**/*', async route => { expect(route.request().url(), 'no external network').toBe(origin + '/'); await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); });
  await page.exposeFunction('__choreDayFetch', async (url: string, method: string) => {
    const parsed = new URL(url), table = parsed.pathname.split('/').pop()!;
    requests.push({ method, pathname: parsed.pathname, family: parsed.searchParams.get('family_id'), query: parsed.search });
    expect(parsed.origin).toBe(origin); expect(method).toBe('GET'); expect(Object.keys(rows)).toContain(table); expect(parsed.pathname).toBe('/rest/v1/' + table); expect(parsed.searchParams.get('family_id')).toBe('eq.' + familyId);
    const result = structuredClone(rows[table]);
    for (const [key, filter] of parsed.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      expect(filter.startsWith('eq.') || filter.startsWith('gt.')).toBe(true);
    }
    return result.filter(row => [...parsed.searchParams].every(([key, filter]) => ['select', 'order', 'limit', 'offset'].includes(key) || (filter.startsWith('eq.') ? String(row[key]) === filter.slice(3) : String(row[key]) > filter.slice(3))));
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk, 'window.react=window.React;', icons]) await page.addScriptTag({ content });
  await page.evaluate(({ sources, entry, zoned, familyId, userId, memberId, origin, messages, zone }) => {
    const w = window as any, R = w.React, D = w.ReactDOM;
    const p: { errors: string[]; actions: string[]; consumedReads: number; clock?: () => { instant: string; deviceZone: string; familyDay: string; deviceDay: string } } = w.__choreDay = { errors: [], actions: [], consumedReads: 0 };
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const client = w.supabase.createClient(origin, 'synthetic-not-a-secret', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url: any, init: any) => {
      const body = await w.__choreDayFetch(String(url), init?.method ?? 'GET');
      const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      const text = response.text.bind(response); response.text = async () => { const value = await text(); p.consumedReads++; return value; }; return response;
    } } });
    // Actual SDK query builders and actual useRealtimeQuery; synthetic channels
    // never open a network connection. No callback is used to force a rerender.
    const db = new Proxy(client, { get(target, property) { if (property === 'channel') return () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe: async () => {} }); if (property === 'removeChannel') return async () => {}; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    const action = (name: string) => async () => { p.actions.push(name); throw new Error('No reward or mutation belongs to this date-render fixture'); };
    const tr = (key: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((s, [key, value]) => s.split('{' + key + '}').join(String(value)), messages[key] ?? key);
    const member = { id: memberId, family_id: familyId, user_id: userId, display_name: 'Synthetic member', is_active: true, role: 'parent', color: null, avatar_url: null };
    // One context, members array and member identity for the entire mounted visit.
    const context = { familyId, userId, family: { id: familyId, timezone: zone }, role: 'parent', members: [member], selfMember: member };
    const mocks: Record<string, any> = {
      react: R, 'react-dom': D, 'lucide-react': w.LucideReact,
      'next/link': { default: (props: any) => R.createElement('a', props, props.children) }, 'next/navigation': { useRouter: () => ({ push: action('navigate') }) },
      '@/components/app/app-context': { useApp: () => context },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => zone },
      '@/components/ui/toast': { useToast: () => ({ success: action('toast-success'), error: (s: string) => p.errors.push(s) }) },
      '@/lib/supabase/client': { createClient: () => db }, '@/lib/offline/cache-scope': { useAuthenticatedCacheScope: () => null, isAuthenticatedCacheScopeCurrent: () => true },
      '@/app/(app)/dashboard/chores/actions': { createChoreAction: action('create'), deleteChoreAssignmentAction: action('delete'), rejectChoreAssignmentAction: action('reject'), respawnChoreAssignmentAction: action('respawn'), setChoreStatusAction: action('status') },
      '@/app/(app)/wallet/actions': { payChoreRewardAction: action('pay') }, '@/app/(app)/dashboard/rewards/actions': { requestRedemptionAction: action('redeem') },
    };
    const cache: Record<string, any> = {};
    function load(id: string): any { if (id in mocks) return mocks[id]; if (cache[id]) return cache[id].exports; const item = sources[id]; if (!item) throw new Error('Missing source ' + id); const compiled = cache[id] = { exports: {} }; new Function('require', 'module', 'exports', item.source)((name: string) => load(item.imports[name]), compiled, compiled.exports); return compiled.exports; }
    p.clock = () => ({ instant: new Date().toISOString(), deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone, familyDay: load(zoned).dayKeyIn(new Date(), zone), deviceDay: load(zoned).dayKeyIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone) });
    D.createRoot(document.getElementById('root')).render(R.createElement(load(entry).ChoresModule));
  }, { sources: modules, entry, zoned, familyId, userId, memberId, origin, messages, zone: scenario.zone });
  await expect.poll(() => page.evaluate(() => (window as any).__choreDay.consumedReads)).toBe(5);
  // Actual readAllById requires an empty tail page even after a short page.
  // Verify the five transport envelopes rather than accepting an arbitrary count.
  for (const [table, tail] of [['chore_assignments', 'assignment-one'], ['chores', 'chore-one']] as const) {
    const calls = requests.filter(request => request.pathname === '/rest/v1/' + table);
    expect(calls.map(call => new URLSearchParams(call.query).get('id'))).toEqual([null, 'gt.' + tail]);
    expect(calls.every(call => new URLSearchParams(call.query).get('order') === 'id.asc' && new URLSearchParams(call.query).get('limit') === '1000')).toBe(true);
  }
  expect(requests.filter(request => request.pathname === '/rest/v1/rewards')).toHaveLength(1);
  await drainRender(page);
  await expect(page.getByRole('heading', { name: messages['chores.chores'], exact: true })).toBeVisible();
  if (scenario.period === 'all') await page.getByRole('combobox', { name: messages['chores.pointsPeriod'], exact: true }).selectOption('all');
  await expect(pointsValue(page)).toHaveText(String(scenario.initialPoints));
  if (scenario.initialStreak) await expect(streakValue(page)).toHaveText('1 day');
  else await expect(streakCard(page).getByText(messages['chores.noActiveStreaksCompleteAChore'], { exact: true })).toBeVisible();
  return { rows, initialRows, requests };
  } catch (error) {
    await test.info().attach('chore-family-day-setup-readonly-observation', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ scenario, requests, rows, initialRows }, null, 2)) });
    throw error;
  }
}

for (const scenario of scenarios) test(scenario.name, async ({ page }, info) => {
  const proof = await mount(page, scenario), observations: unknown[] = [];
  try {
    const before = await page.evaluate(() => (window as any).__choreDay.clock()); observations.push(before);
    expect(before).toMatchObject({ deviceZone: 'UTC', familyDay: scenario.beforeDay });
    const reads = proof.requests.length;
    expect(reads).toBe(5);
    const all = page.locator('.tab-bar').getByRole('button').filter({ hasText: messages['choresModule.tab.all'] });
    const completed = page.locator('.tab-bar').getByRole('button').filter({ hasText: messages['choresModule.tab.completed'] });
    await expect(all).toHaveClass(/(?:^|\s)text-fg(?:\s|$)/);
    await page.clock.setSystemTime(new Date(scenario.after));
    const after = await page.evaluate(() => (window as any).__choreDay.clock()); observations.push(after);
    expect(after).toMatchObject({ deviceZone: 'UTC', familyDay: scenario.afterDay });
    // Actual public tab transition, not a private callback or test-created remount.
    await completed.click(); await expect(completed).toHaveClass(/(?:^|\s)text-fg(?:\s|$)/); await expect(all).not.toHaveClass(/(?:^|\s)text-fg(?:\s|$)/);
    await drainRender(page);
    expect(proof.requests).toHaveLength(reads);
    expect(proof.requests.every(r => r.method === 'GET' && r.family === 'eq.' + familyId)).toBe(true);
    expect(proof.rows).toEqual(proof.initialRows);
    expect(await page.evaluate(() => (window as any).__choreDay.actions)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__choreDay.consumedReads)).toBe(5);
    // Sidebar-only immediate desired results after observed public React commit.
    expect((await pointsValue(page).innerText()).trim()).toBe(String(scenario.finalPoints));
    if (scenario.finalStreak) expect((await streakValue(page).innerText()).trim()).toBe('1 day');
    else {
      expect(await streakValue(page).count()).toBe(0);
      expect(await streakCard(page).getByText(messages['chores.noActiveStreaksCompleteAChore'], { exact: true }).count()).toBe(1);
    }
  } finally {
    await info.attach('chore-family-day-readonly-observation', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ scenario, observations, rows: proof.rows, initialRows: proof.initialRows, requests: proof.requests, runtime: await page.evaluate(() => ({ clock: (window as any).__choreDay.clock(), actions: (window as any).__choreDay.actions, errors: (window as any).__choreDay.errors, consumedReads: (window as any).__choreDay.consumedReads })), sidebar: await page.locator('.module-sidebar').innerText() }, null, 2)) });
  }
});
