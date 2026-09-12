import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page, type Route } from '@playwright/test';

// Corrected DATA-007 regressions; historical characterization is recorded in the cycle doc.
// Actual QuickCapture, AppProvider/cache boundary, ToastProvider, save/parse helpers
// and installed Supabase SDK execute with controlled transport. Shortcut content
// is isolated; no live data or real navigation is performed.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/app/quick-capture.tsx', 'components/capture/capture-shell.tsx', 'lib/capture/document-link.ts', 'components/app/app-context.tsx', 'components/ui/toast.tsx', 'lib/analytics/use-journey.ts',
  'lib/offline/cache.ts', 'lib/offline/cache-scope.tsx', 'lib/auth/cache-session.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts', 'lib/constants/roles.ts', 'lib/capture/save.ts', 'lib/capture/parse.ts', 'lib/capture/shortcut.ts',
  'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
  'components/ui/states.tsx', 'components/ui/states-client.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/ui/modal.tsx', 'components/app/page-header.tsx',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(quickCapture\.|captureShell\.|documentLink\.|toast\.|auth\.cache|states\.|modal\.)/.test(key)));
const origin = 'https://quick-capture-audit-repro-fixture.invalid';
const provider = 'https://quick-capture-audit-repro.supabase.co';
const familyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const parentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Table = 'todo_lists' | 'todo_items' | 'journey_events';
type Row = Record<string, unknown> & { id: string };
type Fixture = {
  rows: Record<Table, Row[]>;
  mode: Partial<Record<Table, 'fail' | 'hold'>>;
  reads: Table[];
  writes: Array<{ table: Table; method: string; body: Record<string, unknown> | null; query: string }>;
  holdMutations: boolean;
  emptyTaskReceipt: boolean;
  failMutation: boolean;
  loseTaskResponse: boolean;
  release: (table: Table) => Promise<void>;
  releaseOne: (table: Table) => Promise<void>;
  finishWrites: () => Promise<void>;
};
type Probe = {
  mount: (family?: string, hasMember?: boolean, claimedUser?: string) => void;
  navigateAway: () => void;
  unmount: () => void;
  settle: () => Promise<void>;
  captureSubmit: () => void;
  captureClick: (text: string) => void;
  capturedClick: () => Promise<void>;
  hotkey: () => void;
  navigations: string[];
  capturedSubmit: () => Promise<void>;
  throwClient: boolean;
  errors: string[];
};
declare global { interface Window { __quickCaptureAudit: Probe } }
const otherFamily = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const listId = '99999999-9999-4999-8999-999999999999';
const list: Row = { id: listId, family_id: familyId, name: 'To-Do', archived_at: null, created_by: parentId, created_at: '2026-09-12T00:00:00Z' };
test.use({ timezoneId: 'UTC' });

async function fixture(page: Page, locale: 'en-US' | 'fr-FR' = 'en-US', screen: 'sheet' | 'shell' = 'sheet'): Promise<Fixture> {
  const catalogue = locale === 'en-US' ? messages : Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(quickCapture\.|captureShell\.|documentLink\.|toast\.|auth\.cache|states\.|modal\.)/.test(key)));
  const held = new Map<Table, Array<() => Promise<void>>>(), pendingWrites: Array<() => Promise<void>> = [];
  const state: Fixture = {
    rows: { todo_lists: [{ ...list }], todo_items: [], journey_events: [] },
    mode: {}, reads: [], writes: [], holdMutations: false, failMutation: false, emptyTaskReceipt: false, loseTaskResponse: false,
    releaseOne: async table => { await (held.get(table) ?? []).shift()?.(); },
    release: async table => { delete state.mode[table]; await Promise.all((held.get(table) ?? []).splice(0).map(release => release())); },
    finishWrites: async () => { state.holdMutations = false; await Promise.all(pendingWrites.splice(0).map(release => release())); },
  };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  const matches = (row: Row, url: URL) => [...url.searchParams].every(([key, value]) =>
    ['select', 'columns', 'order', 'limit'].includes(key) || (value.startsWith('eq.') ? String(row[key]) === value.slice(3) : value === 'is.null' ? row[key] === null : value.startsWith('in.(') ? value.slice(4,-1).split(',').includes(String(row[key])) : value.startsWith('gte.') && String(row[key]) >= value.slice(4)));
  const read = (route: Route, table: Table) => route.fulfill({ status: state.mode[table] === 'fail' ? 403 : 200, headers, contentType: 'application/json',
    body: JSON.stringify(state.mode[table] === 'fail' ? { code: '42501', message: `Fixture ${table} read unavailable`, details: null, hint: null } : state.rows[table].filter(row => matches(row, new URL(route.request().url()))).slice(0, Number(new URL(route.request().url()).searchParams.get('limit') ?? Infinity))) });
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
      if (state.failMutation && table !== 'journey_events') { await route.fulfill({ status: 400, headers, contentType: 'application/json', body: JSON.stringify({ code: '23514', message: 'Fixture mutation rejected' }) }); return; }
      if (table === 'todo_items' && request.method() === 'POST' && state.emptyTaskReceipt) {
        await route.fulfill({ status: 201, headers, contentType: 'application/json', body: '[]' }); return;
      }
      const matching = request.method() === 'POST' ? [] : state.rows[table].filter(row => matches(row, url));
      if (request.method() !== 'POST' && url.searchParams.has('select') && matching.length !== 1) {
        await route.fulfill({ status: 406, headers, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'Fixture conditional write matched no row' }) }); return;
      }
      if (request.method() === 'POST') { const inserted = { id: `10000000-0000-4000-8000-${String(state.writes.length).padStart(12, '0')}`, created_at: new Date().toISOString(), archived_at: null, ...body }; state.rows[table].push(inserted); matching.push(inserted); }
      else if (request.method() === 'PATCH') matching.forEach(row => Object.assign(row, body));
      else if (request.method() === 'DELETE') {
        state.rows[table] = state.rows[table].filter(row => !matching.includes(row));
      }
      else throw new Error(`Unexpected fixture mutation: ${request.method()}`);
      if (state.loseTaskResponse && table === 'todo_items' && request.method() === 'POST') { await route.fulfill({ status: 502, headers, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture response lost after commit' }) }); return; }
      if (url.searchParams.has('select')) await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(request.headers()['accept']?.includes('object') ? matching[0] : matching.map(row => ({ id: row.id }))) });
      else await route.fulfill({ status: request.method() === 'POST' ? 201 : 204, headers });
    };
    if (state.holdMutations && table !== 'journey_events') pendingWrites.push(finish); else await finish();
  });
  await page.clock.setFixedTime(new Date('2026-09-12T12:00:00.000Z'));
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(catalogue)};
    const p = window.__quickCaptureAudit = { errors: [], throwClient: false, navigations: [] };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let currentFamily = ${JSON.stringify(familyId)}, hasMember = true, show = true, claimedUser = ${JSON.stringify(userId)};
    const familyId = ${JSON.stringify(familyId)}, userId = ${JSON.stringify(userId)}, sessionId = '11111111-1111-4111-8111-111111111111';
    const membershipId = () => currentFamily === familyId ? ${JSON.stringify(parentId)} : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const members = () => hasMember ? [{ id: membershipId(), family_id: currentFamily, user_id: userId, display_name: 'Alex', role: 'parent', is_active: true }] : [];
    const db = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-public-anon-fixture', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    db.channel = () => ({ on() { return this; }, subscribe() { return this; } }); db.removeChannel = async () => {};
    const session = { access_token: [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: userId, session_id: sessionId })).replace(/=/g, ''), 'synthetic-signature'].join('.'),
      refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
    db.auth.getSession = async () => ({ data: { session }, error: null });
    db.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    const mocks = { react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/supabase/client': { createClient: () => { if (p.throwClient) { p.throwClient = false; throw new Error('Fixture client construction failure'); } return db; } },
      '@capacitor/core': { Capacitor: { isNativePlatform: () => false } },
      'next/navigation': { useRouter: () => ({ push: href => p.navigations.push(href), back: () => p.navigations.push('back') }) },
      '@/components/capture/document-capture': { DocumentCapture: ({ photo }) => React.createElement('p', { 'data-testid': 'document-capture' }, photo ? 'Photo capture' : 'Document capture') },
      '@/components/capture/capture-shortcuts': { CaptureShortcuts: () => null },
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
    const AppProvider = load('@/components/app/app-context').AppProvider;
    const ToastProvider = load('@/components/ui/toast').ToastProvider;
    const LocaleProvider = load('@/components/i18n/locale-provider').LocaleProvider;
    const locale = load('@/lib/i18n/locales').localeOrDefault(${JSON.stringify(locale)});
    const QuickCapture = load('@/components/app/quick-capture').QuickCapture;
    const CaptureShell = load('@/components/capture/capture-shell').CaptureShell;
    let root;
    function render() {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      const value = { userId: claimedUser, userEmail: 'fixture@example.test', familyId: currentFamily, family: { id: currentFamily, name: 'Fixture family', timezone: 'UTC' }, role: 'parent', families: [], isSuperAdmin: false, defaultDashboard: 'personal', planLevel: 2, featureTiers: {} };
      ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale, source: 'default', messages },
        React.createElement(ToastProvider, null, React.createElement(AppProvider, { value, membershipId: membershipId(), membershipUpdatedAt: '2026-09-12T00:00:00Z', initialMembers: members() }, show ? React.createElement(${JSON.stringify(screen)} === 'shell' ? CaptureShell : QuickCapture) : React.createElement('p', null, 'Other route'))))));
    }
    p.mount = (family = familyId, member = true, user = userId) => { currentFamily = family; hasMember = member; claimedUser = user; show = true; render(); };
    p.navigateAway = () => { show = false; render(); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Invoke React's actual handler to cover its guards independently of the
    // disabled DOM control; retain it to simulate a delayed queued callback.
    function props(element) { return element[Object.keys(element).find(key => key.startsWith('__reactProps$'))]; }
    p.captureClick = text => { const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text); const click = props(button).onClick; p.capturedClick = () => click(); };
    p.hotkey = () => { const element = document.querySelector('form') || document.querySelector('textarea'); props(element).onKeyDown({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault() {}, currentTarget: element }); };
    p.captureSubmit = () => { const submit = props(document.querySelector('form')).onSubmit; p.capturedSubmit = () => submit({ preventDefault() {} }); };
  })();` });
  return state;
}

const taskWrites = (state: Fixture) => state.writes.filter(write => write.table === 'todo_items');
async function mount(page: Page, family = familyId, hasMember = true) {
  await page.evaluate(({ family, hasMember }) => window.__quickCaptureAudit.mount(family, hasMember), { family, hasMember });
  await expect(page.getByRole('button', { name: 'Quick capture', exact: true })).toBeVisible();
}
async function open(page: Page, text = 'Pack lunches') {
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill(text);
}
async function settled(page: Page) { await page.evaluate(() => window.__quickCaptureAudit.settle()); }

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__quickCaptureAudit.errors)).toEqual([]);
});

test('control: actual task save persists correct family/member and its visible Undo removes the same row', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
  expect(state.rows.todo_items).toHaveLength(1);
  expect(state.rows.todo_items[0]).toMatchObject({ family_id: familyId, list_id: listId, title: 'Pack lunches', created_by: parentId, assigned_to_id: parentId });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => state.rows.todo_items.length).toBe(0);
  await expect(page.getByText('Undone', { exact: true })).toBeVisible();
  expect(taskWrites(state).map(write => write.method)).toEqual(['POST', 'DELETE']);
  expect(state.reads).toEqual(['todo_lists']); // Save uses returned id receipt; it does not perform task readback.
});

test('control: successful empty default-list lookup creates a list with member ownership then a task', async ({ page }) => {
  const state = await fixture(page); state.rows.todo_lists = []; await mount(page); await open(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
  expect(state.rows.todo_lists).toHaveLength(1);
  expect(state.rows.todo_lists[0]).toMatchObject({ family_id: familyId, created_by: parentId });
  expect(state.rows.todo_items[0].list_id).toBe(state.rows.todo_lists[0].id);
});

test('control: returned task error keeps the draft, reports failure and allows deliberate retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page); state.failMutation = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Pack lunches');
  expect(state.rows.todo_items).toEqual([]); await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0);
  state.failMutation = false; await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Task saved', { exact: true })).toBeVisible(); expect(state.rows.todo_items).toHaveLength(1);
});

test('control: real access boundary withholds capture when claimed user differs from SDK identity', async ({ page }) => {
  await fixture(page); await page.evaluate(family => window.__quickCaptureAudit.mount(family, true, '99999999-9999-4999-8999-999999999999'), familyId);
  await settled(page); await expect(page.getByRole('button', { name: 'Quick capture', exact: true })).toHaveCount(0);
});



test('same-turn submit and actual form hotkey dispatch only one task', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page); await open(page);
  await page.evaluate(() => { const p = window.__quickCaptureAudit; p.captureSubmit(); void p.capturedSubmit(); void p.capturedSubmit(); p.hotkey(); });
  await expect.poll(() => taskWrites(state).length).toBe(1); await settled(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__quickCaptureAudit.hotkey()); await settled(page); expect(taskWrites(state)).toHaveLength(1);
  await state.finishWrites(); await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
  expect(state.rows.todo_items.map(row => row.title)).toEqual(['Pack lunches']);
});

test('pending close callbacks, Escape and header close cannot falsely cancel an issued save', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page); await open(page);
  await page.evaluate(() => window.__quickCaptureAudit.captureClick('Cancel'));
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => taskWrites(state).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__quickCaptureAudit.capturedClick());
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await state.finishWrites();
  await expect(page.getByRole('dialog')).toHaveCount(0); await open(page, 'New draft');
  expect(state.rows.todo_items.map(row => row.title)).toEqual(['Pack lunches']);
});

for (const prior of ['cancel', 'complete', 'failure'] as const) {
  test(`retained ${prior} opening cannot save or close a later opening`, async ({ page }) => {
    const state = await fixture(page); await mount(page); await open(page);
    await page.evaluate(() => window.__quickCaptureAudit.captureSubmit());
    if (prior !== 'cancel') {
      state.failMutation = prior === 'failure';
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      if (prior === 'failure') await expect(page.getByRole('alert')).toBeVisible();
      else await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
    }
    if (prior !== 'complete') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await open(page, 'Current draft'); state.failMutation = false;
    const before = taskWrites(state).length; await page.evaluate(() => window.__quickCaptureAudit.capturedSubmit()); await settled(page);
    expect(taskWrites(state)).toHaveLength(before); await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Current draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.rows.todo_items.filter(row => row.title === 'Current draft').length).toBe(1);
  });
}

test('actual family boundary retires retained submit and preserves the new family draft', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page); await page.evaluate(() => window.__quickCaptureAudit.captureSubmit());
  await mount(page, otherFamily); await open(page, 'Family B draft');
  await page.evaluate(() => window.__quickCaptureAudit.capturedSubmit()); await settled(page);
  expect(taskWrites(state)).toEqual([]); await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Family B draft');
});

for (const phase of ['lookup', 'list', 'task'] as const) {
  test(`owner retirement during ${phase} await prevents later side effects and stale completion`, async ({ page }) => {
    const state = await fixture(page); await mount(page); await open(page);
    if (phase === 'lookup') state.mode.todo_lists = 'hold';
    else { state.holdMutations = true; if (phase === 'list') state.rows.todo_lists = []; }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    if (phase === 'lookup') await expect.poll(() => state.reads.length).toBe(1);
    else await expect.poll(() => state.writes.filter(write => write.table !== 'journey_events').length).toBe(1);
    await mount(page, otherFamily); await open(page, 'Family B draft');
    if (phase === 'lookup') await state.release('todo_lists'); else await state.finishWrites();
    await settled(page); expect(taskWrites(state)).toHaveLength(phase === 'task' ? 1 : 0);
    await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Family B draft');
  });
}

test('explicit visible earlier-family Undo stays scoped to the captured family and is one-shot', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.evaluate(() => window.__quickCaptureAudit.captureClick('Undo')); await mount(page, otherFamily);
  await page.evaluate(() => { void window.__quickCaptureAudit.capturedClick(); void window.__quickCaptureAudit.capturedClick(); });
  await expect.poll(() => state.rows.todo_items.length).toBe(0); await expect(page.getByText('Undone', { exact: true })).toBeVisible();
  expect(taskWrites(state).map(write => write.method)).toEqual(['POST', 'DELETE']);
  expect(new URLSearchParams(taskWrites(state).at(-1)?.query).get('family_id')).toBe(`eq.${familyId}`);
});

test('required list lookup failure preserves the draft and never creates a list or task; retry recovers', async ({ page }) => {
  const state = await fixture(page); state.mode.todo_lists = 'fail'; await mount(page); await open(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  expect(state.rows.todo_lists).toHaveLength(1); expect(state.writes.filter(write => write.table !== 'journey_events')).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Pack lunches');
  delete state.mode.todo_lists; await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Task saved', { exact: true })).toBeVisible(); expect(state.rows.todo_items[0].list_id).toBe(listId);
});

for (const response of ['empty', 'lost'] as const) {
  test(`${response} dispatched receipt offers review, no fake success/Undo, and no repeat across close/reopen`, async ({ page }) => {
    const state = await fixture(page); state.emptyTaskReceipt = response === 'empty'; state.loseTaskResponse = response === 'lost';
    await mount(page); await open(page); await page.evaluate(() => window.__quickCaptureAudit.captureSubmit());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Review destination', exact: true })).toHaveAttribute('href', '/dashboard/todos');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__quickCaptureAudit.capturedSubmit());
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Pack lunches');
    await page.evaluate(() => window.__quickCaptureAudit.hotkey()); await settled(page); expect(taskWrites(state)).toHaveLength(1);
    expect(state.rows.todo_items).toHaveLength(response === 'empty' ? 0 : 1);
  });
}

test('missing optional roster member retains nullable creator and assignee policy', async ({ page }) => {
  const state = await fixture(page); await mount(page, familyId, false); await open(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
  expect(state.rows.todo_items[0]).toMatchObject({ family_id: familyId, created_by: null, assigned_to_id: null });
});

test('client construction failure is contained, keeps the draft, and permits retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page);
  await page.evaluate(() => { window.__quickCaptureAudit.throwClient = true; });
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled(); expect(taskWrites(state)).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Pack lunches');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByText('Task saved', { exact: true })).toBeVisible();
});

for (const failure of ['factory', 'write', 'receipt'] as const) {
  test(`Undo ${failure} failure is contained and a retained action cannot dispatch again`, async ({ page }) => {
    const state = await fixture(page); await mount(page); await open(page); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible(); await page.evaluate(() => window.__quickCaptureAudit.captureClick('Undo'));
    if (failure === 'factory') await page.evaluate(() => { window.__quickCaptureAudit.throwClient = true; });
    else if (failure === 'write') state.failMutation = true;
    else state.rows.todo_items = []; // An external deletion leaves no matching receipt.
    await page.evaluate(() => { void window.__quickCaptureAudit.capturedClick(); void window.__quickCaptureAudit.capturedClick(); });
    await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByText('Undone', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page);
    expect(taskWrites(state).filter(write => write.method === 'DELETE')).toHaveLength(failure === 'factory' ? 0 : 1);
  });
}

for (const pending of [false, true]) {
  test(`navigation unmount retires ${pending ? 'in-flight' : 'retained'} save without a global success toast`, async ({ page }) => {
    const state = await fixture(page); await mount(page); await open(page); await page.evaluate(() => window.__quickCaptureAudit.captureSubmit());
    if (pending) { state.mode.todo_lists = 'hold'; await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => state.reads.length).toBe(1); }
    await page.evaluate(() => window.__quickCaptureAudit.navigateAway());
    if (pending) await state.release('todo_lists'); else await page.evaluate(() => window.__quickCaptureAudit.capturedSubmit());
    await settled(page); expect(taskWrites(state)).toEqual([]); await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0);
  });
}

test('real French LocaleProvider renders the uncertainty recovery copy and destination', async ({ page }) => {
  const state = await fixture(page, 'fr-FR'); state.emptyTaskReceipt = true;
  await page.evaluate(() => window.__quickCaptureAudit.mount());
  const fr = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  await page.getByRole('button', { name: fr['quickCapture.quickCapture'], exact: true }).click(); await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Préparer les sacs');
  await page.getByRole('button', { name: fr['quickCapture.save'], exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(new RegExp(fr['quickCapture.saveUncertain']));
  await expect(page.getByRole('link', { name: fr['quickCapture.reviewCapture'], exact: true })).toHaveAttribute('href', '/dashboard/todos');
});

async function shell(page: Page) {
  await page.evaluate(() => window.__quickCaptureAudit.mount());
  await expect(page.getByRole('button', { name: 'Capture with AI', exact: true })).toBeVisible();
  await page.getByRole('textbox').fill('Finish homework');
}

const submitShell = (page: Page) => page.getByRole('button', { name: 'Capture with AI', exact: true }).click();

test('full-page capture persists a task, routes to its receipt, and actual Undo removes only that task', async ({ page }) => {
  const state = await fixture(page, 'en-US', 'shell'); await shell(page); await submitShell(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible(); expect(state.rows.todo_items[0]).toMatchObject({ title: 'Finish homework', family_id: familyId, created_by: parentId });
  await page.getByRole('button', { name: 'View in Tasks & Chores', exact: true }).click();
  expect(await page.evaluate(() => window.__quickCaptureAudit.navigations)).toEqual(['/dashboard/todos']);
  await page.evaluate(() => { const p = window.__quickCaptureAudit; p.captureClick('Undo'); void p.capturedClick(); void p.capturedClick(); });
  await expect(page.getByRole('button', { name: 'Capture with AI', exact: true })).toBeVisible(); expect(state.rows.todo_items).toEqual([]);
  await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page);
  expect(taskWrites(state).map(write => write.method)).toEqual(['POST', 'DELETE']);
});

test('full-page synchronous submit and hotkey guard protects pending and completed captures', async ({ page }) => {
  const state = await fixture(page, 'en-US', 'shell'); state.holdMutations = true; await shell(page);
  await page.evaluate(() => { const p = window.__quickCaptureAudit; p.captureClick('Capture with AI'); void p.capturedClick(); void p.capturedClick(); p.hotkey(); });
  await expect.poll(() => taskWrites(state).length).toBe(1); await state.finishWrites(); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.evaluate(() => { void window.__quickCaptureAudit.capturedClick(); window.__quickCaptureAudit.hotkey(); }); await settled(page); expect(taskWrites(state)).toHaveLength(1);
});

for (const failure of ['lookup', 'write', 'factory'] as const) {
  test(`full-page ${failure} failure keeps the editable draft and permits deliberate retry`, async ({ page }) => {
    const state = await fixture(page, 'en-US', 'shell'); await shell(page);
    if (failure === 'lookup') state.mode.todo_lists = 'fail'; else if (failure === 'write') state.failMutation = true;
    else await page.evaluate(() => { window.__quickCaptureAudit.throwClient = true; });
    await submitShell(page); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('textbox')).toHaveValue('Finish homework');
    await expect(page.getByRole('button', { name: 'Capture with AI', exact: true })).toBeEnabled();
    state.failMutation = false; delete state.mode.todo_lists; await submitShell(page); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible(); expect(state.rows.todo_items).toHaveLength(1);
  });
}

for (const response of ['empty', 'lost'] as const) {
  test(`full-page ${response} dispatched response requires destination review and blocks repeat`, async ({ page }) => {
    const state = await fixture(page, 'en-US', 'shell'); state.emptyTaskReceipt = response === 'empty'; state.loseTaskResponse = response === 'lost'; await shell(page);
    await page.evaluate(() => window.__quickCaptureAudit.captureClick('Capture with AI')); await submitShell(page);
    await expect(page.getByRole('link', { name: 'Review destination', exact: true })).toHaveAttribute('href', '/dashboard/todos');
    await expect(page.getByRole('button', { name: 'Capture with AI', exact: true })).toBeDisabled(); await expect(page.getByRole('textbox')).toHaveValue('Finish homework');
    await page.evaluate(() => { void window.__quickCaptureAudit.capturedClick(); window.__quickCaptureAudit.hotkey(); }); await settled(page);
    expect(taskWrites(state)).toHaveLength(1); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });
}

test('full-page earlier intent callbacks cannot submit after editing or capture-another', async ({ page }) => {
  const state = await fixture(page, 'en-US', 'shell'); await shell(page); await page.evaluate(() => window.__quickCaptureAudit.captureClick('Capture with AI'));
  await page.getByRole('textbox').fill('Finish second homework'); await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page); expect(taskWrites(state)).toEqual([]);
  await submitShell(page); await expect(page.getByRole('button', { name: 'Capture another', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Capture another', exact: true }).click(); await page.getByRole('textbox').fill('Finish third homework');
  await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page); expect(taskWrites(state)).toHaveLength(1);
  await expect(page.getByRole('textbox')).toHaveValue('Finish third homework'); await submitShell(page); await expect.poll(() => state.rows.todo_items.length).toBe(2);
});

for (const retirement of ['family', 'navigation'] as const) {
  test(`full-page ${retirement} retirement stops the helper after its required lookup`, async ({ page }) => {
    const state = await fixture(page, 'en-US', 'shell'); state.mode.todo_lists = 'hold'; await shell(page); await submitShell(page); await expect.poll(() => state.reads.length).toBe(1);
    if (retirement === 'family') await page.evaluate(family => window.__quickCaptureAudit.mount(family), otherFamily);
    else await page.evaluate(() => window.__quickCaptureAudit.navigateAway());
    await state.release('todo_lists'); await settled(page); expect(taskWrites(state)).toEqual([]); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });
}


test('retained type callback cannot change a later sheet opening', async ({ page }) => {
  const state = await fixture(page); await mount(page); await open(page);
  await page.evaluate(() => window.__quickCaptureAudit.captureClick('Note'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await open(page, 'Current task');
  await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page);
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Current task'); expect(taskWrites(state)).toEqual([]);
});

test('full-page Photo/Scan modes retire hidden task callbacks and retain document wiring', async ({ page }) => {
  const state = await fixture(page, 'en-US', 'shell'); await shell(page); await page.evaluate(() => window.__quickCaptureAudit.captureClick('Capture with AI'));
  await page.getByRole('button', { name: 'Photo', exact: true }).click(); await expect(page.getByTestId('document-capture')).toHaveText('Photo capture');
  await page.evaluate(() => window.__quickCaptureAudit.capturedClick()); await settled(page); expect(taskWrites(state)).toEqual([]);
  await page.getByRole('button', { name: 'Scan', exact: true }).click(); await expect(page.getByTestId('document-capture')).toHaveText('Document capture');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Type', exact: true }).click(); await expect(page.getByRole('textbox')).toHaveValue('Finish homework');
  await submitShell(page); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
});


test('the required lookup deadline unlocks a retryable draft without any task write', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-12T12:00:00.000Z') });
  const state = await fixture(page); state.mode.todo_lists = 'hold'; await mount(page); await open(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => state.reads.length).toBe(1);
  await page.clock.fastForward(15_001); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Pack lunches');
  expect(taskWrites(state)).toEqual([]); expect(state.reads).toEqual(['todo_lists']);
  await state.release('todo_lists'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Task saved', { exact: true })).toBeVisible(); expect(state.rows.todo_items).toHaveLength(1);
});

test('the dispatched task deadline allows closing but requires review and ignores late acknowledgement', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-12T12:00:00.000Z') });
  const state = await fixture(page); state.holdMutations = true; await mount(page); await open(page);
  await page.evaluate(() => window.__quickCaptureAudit.captureSubmit());
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => taskWrites(state).length).toBe(1);
  await page.clock.fastForward(15_001); await expect(page.getByRole('link', { name: 'Review destination', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await state.finishWrites(); await page.evaluate(() => window.__quickCaptureAudit.capturedSubmit());
  await expect(page.getByText('Task saved', { exact: true })).toHaveCount(0); expect(state.rows.todo_items).toHaveLength(1); expect(taskWrites(state)).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Review destination', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
