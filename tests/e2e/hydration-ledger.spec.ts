import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page, type Route } from '@playwright/test';

// DATA-006 regressions replace the read-only hydration-audit-repro characterization.
// Baseline defects remain documented in hydration-discovery-cycle.md. Actual HabitsModule, query hook, cache boundary, helpers
// and shared controls execute in Chromium with installed Supabase/PostgREST.
// Auth identity/realtime and persisted transport are controlled; no live data.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/modules/habits-module.tsx', 'lib/hooks/use-realtime-query.ts',
  'lib/offline/cache.ts', 'lib/offline/cache-scope.tsx', 'lib/auth/cache-session.ts', 'lib/auth/session-change.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts', 'lib/constants/roles.ts', 'lib/habits/streaks.ts', 'lib/habits/presets.ts', 'lib/members/age.ts',
  'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
  'components/ui/states.tsx', 'components/ui/states-client.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/ui/modal.tsx', 'components/app/page-header.tsx',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(habits\.|habitsModule\.|auth\.cache|states\.|modal\.)/.test(key)));
const origin = 'https://hydration-audit-repro-fixture.invalid';
const provider = 'https://hydration-audit-repro.supabase.co';
const familyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const childId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const parentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Table = 'habits' | 'habit_logs';
type Row = Record<string, unknown> & { id: string };
type Fixture = {
  rows: Record<Table, Row[]>;
  mode: Partial<Record<Table, 'fail' | 'hold'>>;
  reads: Table[];
  writes: Array<{ table: Table; method: string; body: Record<string, unknown> | null; query: string }>;
  holdMutations: boolean;
  failMutation: boolean;
  release: (table: Table) => Promise<void>;
  releaseOne: (table: Table) => Promise<void>;
  finishWrites: () => Promise<void>;
};
type Probe = {
  mount: (role?: 'child' | 'parent', family?: string) => void;
  unmount: () => void;
  seed: (table: Table, rows: Row[]) => void;
  online: () => void;
  settle: () => Promise<void>;
  saveHandler: () => void;
  captureSubmit: () => void;
  capturedSubmit: () => Promise<void>;
  capture: (buttonText: string) => void;
  captured: () => Promise<void>;
  throwMutation: boolean;
  toasts: Array<{ kind: string; message: string }>;
  errors: string[];
};
declare global { interface Window { __hydrationAudit: Probe } }

const habit: Row = { id: 'habit-1', family_id: familyId, member_id: childId, title: 'Drink water fixture', description: null, is_active: true, color: 'blue', cadence: 'daily', target_per_period: 8, weekdays: [], sort_order: 0 };
const logged: Row = { id: 'log-1', family_id: familyId, habit_id: habit.id, member_id: childId, log_date: '2026-09-12', count: 3, created_by: userId };
const otherFamily = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
test.use({ timezoneId: 'UTC' });

async function fixture(page: Page, locale: 'en-US' | 'fr-FR' = 'en-US'): Promise<Fixture> {
  const catalogue = locale === 'en-US' ? messages : Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(habits\.|habitsModule\.|auth\.cache|states\.|modal\.)/.test(key)));
  const held = new Map<Table, Array<() => Promise<void>>>(), pendingWrites: Array<() => Promise<void>> = [];
  const state: Fixture = {
    rows: { habits: [{ ...habit }], habit_logs: [] },
    mode: {}, reads: [], writes: [], holdMutations: false, failMutation: false,
    releaseOne: async table => { await (held.get(table) ?? []).shift()?.(); },
    release: async table => { delete state.mode[table]; await Promise.all((held.get(table) ?? []).splice(0).map(release => release())); },
    finishWrites: async () => { state.holdMutations = false; await Promise.all(pendingWrites.splice(0).map(release => release())); },
  };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  const matches = (row: Row, url: URL) => [...url.searchParams].every(([key, value]) =>
    ['select', 'columns', 'order'].includes(key) || (value.startsWith('eq.') ? String(row[key]) === value.slice(3) : value === 'is.null' ? row[key] === null : value.startsWith('gte.') && String(row[key]) >= value.slice(4)));
  const read = (route: Route, table: Table) => route.fulfill({ status: state.mode[table] === 'fail' ? 403 : 200, headers, contentType: 'application/json',
    body: JSON.stringify(state.mode[table] === 'fail' ? { code: '42501', message: `Fixture ${table} read unavailable`, details: null, hint: null } : state.rows[table].filter(row => matches(row, new URL(route.request().url())))) });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return; }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const table = url.pathname.split('/').at(-1) as Table;
    if (!(table in state.rows)) throw new Error(`Unexpected fixture table: ${table}`);
    if (request.method() === 'GET') {
      state.reads.push(table);
      if (state.mode[table] === 'hold') { const queue = held.get(table) ?? []; queue.push(() => read(route, table)); held.set(table, queue); }
      else await read(route, table);
      return;
    }
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    state.writes.push({ table, method: request.method(), body, query: url.search });
    const finish = async () => {
      if (state.failMutation) { await route.fulfill({ status: 400, headers, contentType: 'application/json', body: JSON.stringify({ code: '23514', message: 'Fixture mutation rejected' }) }); return; }
      if (table === 'habit_logs' && request.method() === 'POST' && state.rows[table].some(row => row.habit_id === body?.habit_id && row.log_date === body?.log_date)) {
        await route.fulfill({ status: 409, headers, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Fixture unique habit day conflict' }) }); return;
      }
      const matching = state.rows[table].filter(row => matches(row, url));
      if (request.method() !== 'POST' && url.searchParams.has('select') && matching.length !== 1) {
        await route.fulfill({ status: 406, headers, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'Fixture conditional write matched no row' }) }); return;
      }
      if (request.method() === 'POST') { const inserted = { id: `written-${state.writes.length}`, created_at: new Date().toISOString(), is_active: true, ...body }; state.rows[table].push(inserted); matching.push(inserted); }
      else if (request.method() === 'PATCH') matching.forEach(row => Object.assign(row, body));
      else if (request.method() === 'DELETE') {
        state.rows[table] = state.rows[table].filter(row => !matching.includes(row));
      }
      else throw new Error(`Unexpected fixture mutation: ${request.method()}`);
      if (url.searchParams.has('select')) await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(matching[0]) });
      else await route.fulfill({ status: request.method() === 'POST' ? 201 : 204, headers });
    };
    if (state.holdMutations) pendingWrites.push(finish); else await finish();
  });
  await page.clock.setFixedTime(new Date('2026-09-12T12:00:00.000Z'));
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(catalogue)};
    const p = window.__hydrationAudit = { toasts: [], errors: [], throwMutation: false };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let currentFamily = ${JSON.stringify(familyId)}; const familyId = ${JSON.stringify(familyId)}, userId = ${JSON.stringify(userId)}, sessionId = '11111111-1111-4111-8111-111111111111';
    const members = [{ id: ${JSON.stringify(childId)}, family_id: familyId, user_id: userId, display_name: 'Casey', role: 'child' },
      { id: ${JSON.stringify(parentId)}, family_id: familyId, user_id: userId, display_name: 'Alex', role: 'parent' }];
    let role = 'parent';
    const app = () => {
      const currentMembers = members.map(member => ({ ...member, family_id: currentFamily,
        id: currentFamily === familyId ? member.id : member.role === 'parent' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : '99999999-9999-4999-8999-999999999999' }));
      return { familyId: currentFamily, userId, members: currentMembers, selfMember: currentMembers.find(member => member.role === role), role };
    };
    const db = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-public-anon-fixture', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const from = db.from.bind(db);
    db.from = table => { if (p.throwMutation) { p.throwMutation = false; throw new Error('Fixture thrown mutation'); } return from(table); };
    db.channel = () => ({ on() { return this; }, subscribe() { return this; } }); db.removeChannel = async () => {};
    const session = { access_token: [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: userId, session_id: sessionId })).replace(/=/g, ''), 'synthetic-signature'].join('.'),
      refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
    db.auth.getSession = async () => ({ data: { session }, error: null });
    db.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    const mocks = {
      '@/lib/auth/browser-session-storage': { captureBrowserSessionSnapshot: () => { throw new Error('Cookie transport is outside this fixture'); } }, react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/app/app-context': { useApp: app }, '@/lib/supabase/client': { createClient: () => db },
      '@/components/ui/toast': { useToast: () => ({ success: message => p.toasts.push({ kind: 'success', message }), error: message => p.toasts.push({ kind: 'error', message }) }) },
      '@/components/ui/avatar': { Avatar: () => null }, '@/components/ai/ai-insight': { AiInsight: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id]; if (modules[id]) return modules[id];
      if (id.startsWith('@/lib/i18n/messages/') && id.endsWith('.json')) return { default: {} };
      if (!(id in sources)) throw new Error('Unexpected fixture module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const { AuthenticatedCacheBoundary, cacheAccessKey } = load('@/lib/offline/cache-scope');
    const LocaleProvider = load('@/components/i18n/locale-provider').LocaleProvider;
    const locale = load('@/lib/i18n/locales').localeOrDefault(${JSON.stringify(locale)});
    const cache = load('@/lib/offline/cache'), Habits = load('@/components/modules/habits-module').HabitsModule;
    const access = () => ({ userId, familyId: currentFamily, memberId: app().selfMember.id, membershipUpdatedAt: '2026-09-12T00:00:00Z', role, isSuperAdmin: false, planLevel: 2, featureTiers: {} });
    p.seed = (table, rows) => cache.writePartitionedCache(cache.cacheIdentity({ userId, sessionId, accessIdentity: cacheAccessKey(access()) }, table, familyId, table === 'habit_logs' ? [familyId, load('@/lib/habits/streaks').toISODate(new Date())] : [familyId]), rows);
    let root;
    p.mount = (nextRole = 'parent', family = familyId) => { role = nextRole; currentFamily = family; root ??= ReactDOM.createRoot(document.getElementById('root')); ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale, source: 'default', messages }, React.createElement(AuthenticatedCacheBoundary, { access: access() }, React.createElement(Habits))))); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.online = () => window.dispatchEvent(new Event('online'));
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Invoke React's actual handler to cover its guards independently of the
    // disabled DOM control; retain it to simulate a delayed queued callback.
    function props(element) { return element[Object.keys(element).find(key => key.startsWith('__reactProps$'))]; }
    p.capture = text => { const button = [...document.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === text); if (!button) throw new Error('Missing fixture button: ' + text); const callback = props(button).onClick; p.captured = () => callback({ preventDefault() {} }); };
    p.saveHandler = () => props(document.querySelector('form')).onSubmit({ preventDefault() {} });
    p.captureSubmit = () => { const submit = props(document.querySelector('form')).onSubmit; p.capturedSubmit = () => submit({ preventDefault() {} }); };
  })();` });
  return state;
}

const add = (page: Page) => page.getByRole('button', { name: 'Add one', exact: true });
const remove = (page: Page) => page.getByRole('button', { name: 'Remove one', exact: true });
const count = (page: Page, amount: number) => page.getByText(`${amount} / 8 today`, { exact: true });
async function mount(page: Page) { await page.evaluate(() => window.__hydrationAudit.mount()); }
async function ready(page: Page, amount = 0) { await expect(count(page, amount)).toBeVisible(); }
async function capture(page: Page) { await page.evaluate(() => window.__hydrationAudit.capture('Add one')); }
async function invoke(page: Page) { await page.evaluate(() => window.__hydrationAudit.captured()); }

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__hydrationAudit.errors)).toEqual([]);
});

test('control: add, increment, decrement and remove persist with explicit readback', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  const reads = state.reads.length;
  await expect(remove(page)).toBeDisabled();
  await add(page).click(); await ready(page, 1);
  await add(page).click(); await ready(page, 2);
  await remove(page).click(); await ready(page, 1);
  await remove(page).click(); await ready(page);
  expect(state.rows.habit_logs).toEqual([]);
  expect(state.writes.map(write => write.method)).toEqual(['POST', 'PATCH', 'PATCH', 'DELETE']);
  expect(state.writes[0].body).toMatchObject({ family_id: familyId, member_id: childId, habit_id: habit.id, log_date: '2026-09-12', count: 1, created_by: userId });
  expect(state.reads.length).toBeGreaterThanOrEqual(reads + 4);
  expect(await page.evaluate(() => window.__hydrationAudit.errors)).toEqual([]);
});

test('control: hydration preset creates the assigned habit and then persists a cup', async ({ page }) => {
  const state = await fixture(page); state.rows.habits = []; await mount(page);
  await page.getByRole('button', { name: 'New Habit', exact: true }).first().click();
  await page.getByRole('button', { name: /Drink water/ }).click();
  await page.getByRole('button', { name: 'Create Habit', exact: true }).click();
  await ready(page);
  expect(state.rows.habits).toHaveLength(1);
  expect(state.rows.habits[0]).toMatchObject({ title: '💧 Drink water', family_id: familyId, member_id: parentId, target_per_period: 8 });
  await add(page).click(); await ready(page, 1);
  expect(state.rows.habit_logs[0]).toMatchObject({ habit_id: state.rows.habits[0].id, member_id: parentId, family_id: familyId, count: 1 });
});

for (const mode of ['fail', 'hold'] as const) {
  test(`control: catalog ${mode} withholds the count controls`, async ({ page }) => {
    const state = await fixture(page); state.mode.habits = mode; await mount(page);
    await expect.poll(() => state.reads.includes('habits')).toBe(true);
    await page.evaluate(() => window.__hydrationAudit.settle());
    await expect(add(page)).toHaveCount(0);
    if (mode === 'fail') {
      delete state.mode.habits;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
    } else await state.release('habits');
    await ready(page); expect(state.writes).toEqual([]);
  });

  test(`required log ${mode} withholds counts and writes until usable recovery`, async ({ page }) => {
    const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; state.mode.habit_logs = mode;
    await mount(page); await expect.poll(() => state.reads.includes('habit_logs')).toBe(true);
    await page.evaluate(() => window.__hydrationAudit.settle());
    await expect(add(page)).toHaveCount(0); await expect(count(page, 0)).toHaveCount(0);
    expect(state.writes).toEqual([]);
    if (mode === 'fail') {
      delete state.mode.habit_logs; await page.getByRole('button', { name: 'Try again', exact: true }).click();
    } else await state.release('habit_logs');
    await ready(page, 3); await add(page).click(); await ready(page, 4);
    expect(state.writes).toHaveLength(1); expect(state.writes[0].method).toBe('PATCH');
  });
}

test('cached stale totals cannot overwrite newer persisted totals while refresh is pending', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged, count: 8 }]; state.mode.habit_logs = 'hold';
  await page.evaluate(row => window.__hydrationAudit.seed('habit_logs', [row]), logged);
  await mount(page); await expect.poll(() => state.reads.includes('habit_logs')).toBe(true);
  await page.evaluate(() => window.__hydrationAudit.settle());
  await expect(add(page)).toHaveCount(0); expect(state.writes).toEqual([]);
  await state.release('habit_logs'); await ready(page, 8);
  await add(page).click(); await ready(page, 9);
  expect(state.writes[0]).toMatchObject({ method: 'PATCH', body: { count: 9 } });
  const query = new URLSearchParams(state.writes[0].query);
  expect(Object.fromEntries(query)).toMatchObject({ family_id: `eq.${familyId}`, habit_id: 'eq.habit-1', count: 'eq.8', log_date: 'eq.2026-09-12', member_id: `eq.${childId}` });
});

test('stale catalog withholds logging until the current active-habit read returns', async ({ page }) => {
  const state = await fixture(page); state.rows.habits[0].is_active = false; state.mode.habits = 'hold';
  await page.evaluate(row => window.__hydrationAudit.seed('habits', [row]), habit);
  await mount(page); await expect.poll(() => state.reads.includes('habits')).toBe(true);
  await page.evaluate(() => window.__hydrationAudit.settle());
  await expect(add(page)).toHaveCount(0);
  await state.release('habits'); await expect(page.getByText('No habits yet', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('same-turn duplicate count callbacks issue one write while a later deliberate increment still works', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; state.holdMutations = true;
  await mount(page); await ready(page, 3); await capture(page);
  await page.evaluate(() => { void window.__hydrationAudit.captured(); void window.__hydrationAudit.captured(); });
  await expect.poll(() => state.writes.length).toBe(1); await expect(add(page)).toBeDisabled();
  await state.finishWrites(); await ready(page, 4); await expect(add(page)).toBeEnabled();
  await add(page).click(); await ready(page, 5); expect(state.writes).toHaveLength(2);
});

test('retained callback uses the latest verified count after successful readback', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; await mount(page); await ready(page, 3);
  await capture(page); await add(page).click(); await ready(page, 4); await expect(add(page)).toBeEnabled();
  await invoke(page); await ready(page, 5);
  expect(state.writes.map(write => write.body)).toEqual([{ count: 4 }, { count: 5 }]);
});

test('retained callback cannot mutate the previous family after the real boundary switches owner', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  state.rows.habits.push({ ...habit, id: 'habit-b', member_id: null, family_id: otherFamily, title: 'Family B water' });
  await mount(page); await ready(page, 3); await capture(page);
  await page.evaluate(family => window.__hydrationAudit.mount('parent', family), otherFamily);
  await expect(page.getByText('Family B water', { exact: true })).toBeVisible();
  await invoke(page); await page.evaluate(() => window.__hydrationAudit.settle());
  expect(state.rows.habit_logs[0].count).toBe(3); expect(state.writes).toEqual([]); await ready(page);
  await add(page).click(); await ready(page, 1);
  expect(state.writes[0].body).toMatchObject({ family_id: otherFamily, habit_id: 'habit-b', member_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
});

test('retained callback cannot write after component unmount', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  await mount(page); await ready(page, 3); await capture(page); await page.evaluate(() => window.__hydrationAudit.unmount());
  await invoke(page); await page.evaluate(() => window.__hydrationAudit.settle());
  expect(state.writes).toEqual([]); expect(state.rows.habit_logs[0].count).toBe(3);
});

test('midnight rejects the old-day action and logs only after current UTC day refresh', async ({ page }) => {
  const state = await fixture(page); await page.clock.setFixedTime(new Date('2026-09-12T23:59:59.000Z'));
  await mount(page); await ready(page); await page.clock.setFixedTime(new Date('2026-09-13T00:00:01.000Z'));
  await add(page).click(); await expect.poll(() => state.reads.filter(table => table === 'habit_logs').length).toBe(2);
  await ready(page); expect(state.writes).toEqual([]);
  await add(page).click(); await ready(page, 1);
  expect(state.writes[0].body).toMatchObject({ log_date: '2026-09-13', count: 1 });
});

test('returned write failure retains count and recovers after verified readback', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; state.failMutation = true;
  await mount(page); await ready(page, 3); await add(page).click();
  await expect.poll(() => page.evaluate(() => window.__hydrationAudit.toasts.filter(toast => toast.kind === 'error').length)).toBe(1);
  expect(state.rows.habit_logs[0].count).toBe(3); await ready(page, 3);
  state.failMutation = false; await add(page).click(); await ready(page, 4);
});

test('failed mutation readback blocks counts until retry confirms the persisted total', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; await mount(page); await ready(page, 3);
  state.mode.habit_logs = 'fail'; await add(page).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(state.rows.habit_logs[0].count).toBe(4); await expect(add(page)).toHaveCount(0);
  delete state.mode.habit_logs; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await ready(page, 4); await add(page).click(); await ready(page, 5);
  expect(state.writes.map(write => write.body)).toEqual([{ count: 4 }, { count: 5 }]);
});

test('thrown SDK failure is contained and readback permits a deliberate retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.evaluate(() => { window.__hydrationAudit.throwMutation = true; }); await add(page).click();
  await expect.poll(() => page.evaluate(() => window.__hydrationAudit.toasts.filter(toast => toast.kind === 'error').length)).toBe(1);
  expect(await page.evaluate(() => window.__hydrationAudit.errors)).toEqual([]); expect(state.writes).toEqual([]);
  await add(page).click(); await ready(page, 1);
});

test('superseded readback keeps the guard until the newer committed read confirms the saved count', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  await mount(page); await ready(page, 3); await capture(page);
  state.mode.habit_logs = 'hold'; await add(page).click();
  await expect.poll(() => state.reads.filter(table => table === 'habit_logs').length).toBe(2);
  await page.evaluate(() => window.__hydrationAudit.online());
  await expect.poll(() => state.reads.filter(table => table === 'habit_logs').length).toBe(3);
  await state.releaseOne('habit_logs'); await page.evaluate(() => window.__hydrationAudit.settle());
  await expect(add(page)).toBeDisabled(); await ready(page, 3);
  await invoke(page); expect(state.writes).toHaveLength(1);
  await state.release('habit_logs'); await ready(page, 4); await expect(add(page)).toBeEnabled();
  await add(page).click(); await ready(page, 5);
});

test('superseding read error blocks the next increment until explicit retry', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  await mount(page); await ready(page, 3); state.mode.habit_logs = 'hold'; await add(page).click();
  await expect.poll(() => state.reads.filter(table => table === 'habit_logs').length).toBe(2);
  await page.evaluate(() => window.__hydrationAudit.online());
  await expect.poll(() => state.reads.filter(table => table === 'habit_logs').length).toBe(3);
  await state.releaseOne('habit_logs'); state.mode.habit_logs = 'fail'; await state.releaseOne('habit_logs');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(add(page)).toHaveCount(0); expect(state.writes).toHaveLength(1);
  delete state.mode.habit_logs; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await ready(page, 4); await add(page).click(); await ready(page, 5);
});

test('concurrent persisted count change rejects stale conditional update and recovers latest total', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; await mount(page); await ready(page, 3);
  state.rows.habit_logs[0].count = 8; await add(page).click(); await ready(page, 8);
  expect(state.rows.habit_logs[0].count).toBe(8);
  await expect.poll(() => page.evaluate(() => window.__hydrationAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  await add(page).click(); await ready(page, 9);
});

test('concurrent unique day insert is read back and never blindly overwritten', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.rows.habit_logs.push({ ...logged }); await add(page).click(); await ready(page, 3);
  expect(state.rows.habit_logs).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__hydrationAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  await add(page).click(); await ready(page, 4);
});

test('same-owner draft survives log read failure and the modal provides its own retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Habit', { exact: true }).fill('Retained water draft');
  state.mode.habit_logs = 'fail'; await page.evaluate(() => window.__hydrationAudit.online());
  await expect(dialog.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create Habit', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__hydrationAudit.saveHandler()); expect(state.writes).toEqual([]);
  delete state.mode.habit_logs; await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create Habit', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Habit', { exact: true })).toHaveValue('Retained water draft');
  await dialog.getByRole('button', { name: 'Create Habit', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(state.rows.habits.some(row => row.title === 'Retained water draft')).toBe(true);
});

test('pending preset save blocks duplicate and Cancel callbacks, then a confirmed create closes before failed readback can invite duplication', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Habit', { exact: true }).fill('Only one new habit');
  state.holdMutations = true;
  await page.evaluate(() => { window.__hydrationAudit.saveHandler(); window.__hydrationAudit.saveHandler(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__hydrationAudit.capture('Cancel')); await invoke(page); await expect(dialog).toBeVisible();
  state.mode.habits = 'fail'; await state.finishWrites();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(state.rows.habits.filter(row => row.title === 'Only one new habit')).toHaveLength(1);
  delete state.mode.habits; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Only one new habit', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
});

test('late count acknowledgement cannot disturb the new family or its draft', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  state.rows.habits.push({ ...habit, id: 'habit-b', member_id: null, family_id: otherFamily, title: 'Family B water' });
  await mount(page); await ready(page, 3); state.holdMutations = true; await add(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.evaluate(family => window.__hydrationAudit.mount('parent', family), otherFamily);
  await expect(page.getByText('Family B water', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Habit', { exact: true }).fill('Family B draft');
  await state.finishWrites(); await page.evaluate(() => window.__hydrationAudit.settle());
  await expect(dialog.getByLabel('Habit', { exact: true })).toHaveValue('Family B draft');
  expect(state.writes).toHaveLength(1); expect(state.rows.habit_logs[0]).toMatchObject({ family_id: familyId, count: 4 });
  expect(await page.evaluate(() => window.__hydrationAudit.toasts)).toEqual([]);
});

test('target-of-one hydration check-in toggles the existing day slot and reads both outcomes', async ({ page }) => {
  const state = await fixture(page); state.rows.habits[0].target_per_period = 1; await mount(page);
  const toggle = page.getByRole('button', { name: 'Toggle today', exact: true }); await expect(toggle).toBeEnabled();
  await toggle.click(); await expect.poll(() => state.rows.habit_logs.length).toBe(1);
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect.poll(() => state.rows.habit_logs.length).toBe(0); expect(state.writes.map(write => write.method)).toEqual(['POST', 'DELETE']);
});

test('periodic UTC day check advances an open page without a user action', async ({ page }) => {
  await page.clock.install(); const state = await fixture(page); state.rows.habit_logs = [{ ...logged }];
  await page.clock.setSystemTime(new Date('2026-09-12T23:59:30.000Z')); await mount(page); await ready(page, 3);
  await page.clock.runFor(60_001); await ready(page);
  await add(page).click(); await ready(page, 1);
  expect(state.writes[0].body?.log_date).toBe('2026-09-13');
  expect(state.rows.habit_logs.find(row => row.log_date === '2026-09-12')?.count).toBe(3);
});

test('actual French locale provider renders new conflict copy and preserves the concurrent count', async ({ page }) => {
  const state = await fixture(page, 'fr-FR'); state.rows.habit_logs = [{ ...logged }]; await mount(page); await ready(page, 3);
  state.rows.habit_logs[0].count = 8;
  const french = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8')) as Record<string, string>;
  await page.getByRole('button', { name: french['habits.addOne'], exact: true }).click(); await ready(page, 8);
  await expect.poll(() => page.evaluate(() => window.__hydrationAudit.toasts)).toEqual([
    { kind: 'error', message: 'Cette habitude a été modifiée. Actualisez la page et réessayez.' },
  ]);
  expect(state.rows.habit_logs[0].count).toBe(8);
});

test('edit and archive use guarded persisted readback while an archived habit rejects its retained count handler', async ({ page }) => {
  const state = await fixture(page); state.rows.habit_logs = [{ ...logged }]; await mount(page); await ready(page, 3);
  await page.getByRole('button', { name: 'Edit habit', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Habit', { exact: true }).fill('Updated water habit');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('Updated water habit', { exact: true })).toBeVisible();
  await expect(add(page)).toBeEnabled(); await capture(page);
  page.once('dialog', prompt => prompt.accept());
  await page.getByRole('button', { name: 'Archive habit', exact: true }).click();
  await expect(page.getByText('No habits yet', { exact: true })).toBeVisible();
  await invoke(page); await page.evaluate(() => window.__hydrationAudit.settle());
  expect(state.writes).toHaveLength(2); expect(state.writes.every(write => write.query.includes('family_id'))).toBe(true);
  expect(state.rows.habits[0]).toMatchObject({ is_active: false, title: 'Updated water habit', target_per_period: 8 });
  expect(state.rows.habit_logs[0].count).toBe(3);
});

for (const reopen of [false, true]) test(`retired preset submit cannot create again${reopen ? ' after another form opens' : ' after its form closes'}`, async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Habit', { exact: true }).fill('One hydration habit');
  await page.evaluate(() => window.__hydrationAudit.captureSubmit());
  await page.getByRole('dialog').getByRole('button', { name: 'Create Habit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Habit', exact: true })).toBeEnabled();
  if (reopen) {
    await page.getByRole('button', { name: 'New Habit', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Habit', { exact: true }).fill('New current draft');
  }
  await page.evaluate(() => window.__hydrationAudit.capturedSubmit()); await page.evaluate(() => window.__hydrationAudit.settle());
  expect(state.rows.habits.filter(row => row.title === 'One hydration habit')).toHaveLength(1);
  expect(state.writes).toHaveLength(1);
  if (reopen) {
    await expect(page.getByRole('dialog').getByLabel('Habit', { exact: true })).toHaveValue('New current draft');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Habit', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.rows.habits.filter(row => row.title === 'New current draft')).toHaveLength(1);
  }
});

test('canceled preset form retires its retained submit without discarding a newly opened draft', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Habit', { exact: true }).fill('Canceled habit');
  await page.evaluate(() => window.__hydrationAudit.captureSubmit());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'New Habit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Habit', { exact: true }).fill('Current habit');
  await page.evaluate(() => window.__hydrationAudit.capturedSubmit()); await page.evaluate(() => window.__hydrationAudit.settle());
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('dialog').getByLabel('Habit', { exact: true })).toHaveValue('Current habit');
});
