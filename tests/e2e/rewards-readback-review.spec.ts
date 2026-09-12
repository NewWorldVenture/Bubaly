import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page, type Route } from '@playwright/test';

// Independent review of deferred mutation completion.
// Actual RewardsModule, query hook, cache boundary, ledger math and shared form
// controls execute in Chromium. Installed Supabase/PostgREST performs the reads
// and writes against an intercepted, persisted fixture. Auth identity, realtime
// delivery, avatars and AI are controlled; no live database or points are used.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/modules/rewards-module.tsx', 'lib/hooks/use-realtime-query.ts',
  'lib/offline/cache.ts', 'lib/offline/cache-scope.tsx', 'lib/auth/cache-session.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts', 'lib/constants/roles.ts', 'lib/rewards/points.ts',
  'components/ui/states.tsx', 'components/ui/states-client.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/ui/modal.tsx', 'components/app/page-header.tsx',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(rewards\.|rewardsModule\.|auth\.cache|states\.|modal\.)/.test(key)));
const origin = 'https://rewards-readback-review-fixture.invalid';
const provider = 'https://rewards-readback-review.supabase.co';
const familyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const childId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const parentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Table = 'rewards' | 'chore_assignments' | 'reward_redemptions';
type Row = Record<string, unknown> & { id: string };
type Fixture = {
  rows: Record<Table, Row[]>;
  mode: Partial<Record<Table, 'fail' | 'hold'>>;
  reads: Table[];
  writes: Array<{ table: Table; method: string; body: Record<string, unknown> | null }>;
  holdMutations: boolean;
  failMutation: boolean;
  release: (table: Table) => Promise<void>;
  releaseOne: (table: Table) => Promise<void>;
  finishWrites: () => Promise<void>;
};
type Probe = {
  mount: (role?: 'child' | 'parent') => void;
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
declare global { interface Window { __rewardsReadbackReview: Probe } }

const reward: Row = { id: 'reward-1', family_id: familyId, title: 'Movie night', description: 'Choose a movie', cost_points: 100 };
const assignment: Row = { id: 'assignment-1', family_id: familyId, member_id: childId, status: 'approved', points_awarded: 100 };
const spent: Row = { id: 'spent-1', family_id: familyId, reward_id: reward.id, member_id: childId, reward_title: 'Past reward', cost_points: 100, status: 'fulfilled', created_at: '2026-09-10T00:00:00Z' };
const requested: Row = { ...spent, id: 'requested-1', reward_title: 'Movie night', status: 'requested' };

async function fixture(page: Page): Promise<Fixture> {
  const held = new Map<Table, Array<() => Promise<void>>>(), pendingWrites: Array<() => Promise<void>> = [];
  const state: Fixture = {
    rows: { rewards: [{ ...reward }], chore_assignments: [{ ...assignment }], reward_redemptions: [{ ...spent }] },
    mode: {}, reads: [], writes: [], holdMutations: false, failMutation: false,
    release: async table => { delete state.mode[table]; await Promise.all((held.get(table) ?? []).splice(0).map(release => release())); },
    releaseOne: async table => { const release = held.get(table)?.shift(); if (!release) throw new Error('No held read'); await release(); },
    finishWrites: async () => { state.holdMutations = false; await Promise.all(pendingWrites.splice(0).map(release => release())); },
  };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  const read = (route: Route, table: Table) => route.fulfill({ status: state.mode[table] === 'fail' ? 403 : 200, headers, contentType: 'application/json',
    body: JSON.stringify(state.mode[table] === 'fail' ? { code: '42501', message: `Fixture ${table} read unavailable`, details: null, hint: null } : state.rows[table]) });
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
    state.writes.push({ table, method: request.method(), body });
    const finish = async () => {
      if (state.failMutation) { await route.fulfill({ status: 400, headers, contentType: 'application/json', body: JSON.stringify({ code: '23514', message: 'Fixture mutation rejected' }) }); return; }
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      if (request.method() === 'POST') state.rows[table].push({ id: `written-${state.writes.length}`, created_at: new Date().toISOString(), ...body });
      else if (request.method() === 'PATCH') state.rows[table] = state.rows[table].map(row => row.id === id ? { ...row, ...body } : row);
      else if (request.method() === 'DELETE') state.rows[table] = state.rows[table].filter(row => row.id !== id);
      else throw new Error(`Unexpected fixture mutation: ${request.method()}`);
      await route.fulfill({ status: request.method() === 'POST' ? 201 : 204, headers });
    };
    if (state.holdMutations) pendingWrites.push(finish); else await finish();
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)};
    const p = window.__rewardsReadbackReview = { toasts: [], errors: [], throwMutation: false };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const familyId = ${JSON.stringify(familyId)}, userId = ${JSON.stringify(userId)}, sessionId = '11111111-1111-4111-8111-111111111111';
    const members = [{ id: ${JSON.stringify(childId)}, family_id: familyId, user_id: userId, display_name: 'Casey', role: 'child' },
      { id: ${JSON.stringify(parentId)}, family_id: familyId, user_id: userId, display_name: 'Alex', role: 'parent' }];
    let role = 'child';
    const app = () => ({ familyId, userId, members, selfMember: members.find(member => member.role === role), role });
    const db = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-public-anon-fixture', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const from = db.from.bind(db);
    db.from = table => { if (p.throwMutation) { p.throwMutation = false; throw new Error('Fixture thrown mutation'); } return from(table); };
    db.channel = () => ({ on() { return this; }, subscribe() { return this; } }); db.removeChannel = async () => {};
    const session = { access_token: [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: userId, session_id: sessionId })).replace(/=/g, ''), 'synthetic-signature'].join('.'),
      refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
    db.auth.getSession = async () => ({ data: { session }, error: null });
    db.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    const mocks = { react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/app/app-context': { useApp: app }, '@/lib/supabase/client': { createClient: () => db },
      '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
      '@/components/ui/toast': { useToast: () => ({ success: message => p.toasts.push({ kind: 'success', message }), error: message => p.toasts.push({ kind: 'error', message }) }) },
      '@/components/ui/avatar': { Avatar: () => null }, '@/components/ai/ai-insight': { AiInsight: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id]; if (modules[id]) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const { AuthenticatedCacheBoundary, cacheAccessKey } = load('@/lib/offline/cache-scope');
    const cache = load('@/lib/offline/cache'), Rewards = load('@/components/modules/rewards-module').RewardsModule;
    const access = () => ({ userId, familyId, memberId: app().selfMember.id, membershipUpdatedAt: '2026-09-12T00:00:00Z', role, isSuperAdmin: false, planLevel: 2, featureTiers: {} });
    p.seed = (table, rows) => cache.writePartitionedCache(cache.cacheIdentity({ userId, sessionId, accessIdentity: cacheAccessKey(access()) }, table, familyId, [familyId]), rows);
    let root;
    p.mount = (nextRole = 'child') => { role = nextRole; root ??= ReactDOM.createRoot(document.getElementById('root')); ReactDOM.flushSync(() => root.render(React.createElement(AuthenticatedCacheBoundary, { access: access() }, React.createElement(Rewards)))); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.online = () => window.dispatchEvent(new Event('online'));
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Invoke React's actual handler to cover its guards independently of the
    // disabled DOM control; retain it to simulate a delayed queued callback.
    function props(element) { return element[Object.keys(element).find(key => key.startsWith('__reactProps$'))]; }
    p.capture = text => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text); if (!button) throw new Error('Missing fixture button: ' + text); const callback = props(button).onClick; p.captured = () => callback({ preventDefault() {} }); };
    p.saveHandler = () => props(document.querySelector('form')).onSubmit({ preventDefault() {} });
    p.captureSubmit = () => { const submit = props(document.querySelector('form')).onSubmit; p.capturedSubmit = () => submit({ preventDefault() {} }); };
  })();` });
  return state;
}
async function mount(page: Page, role: 'child' | 'parent' = 'child') { await page.evaluate(role => window.__rewardsReadbackReview.mount(role), role); }
async function ready(page: Page) { await expect(page.getByText('Points Leaderboard', { exact: true })).toBeVisible(); }
async function finish(page: Page) { await page.evaluate(() => window.__rewardsReadbackReview.settle()); }
async function noWrites(state: Fixture) { expect(state.writes).toEqual([]); }
test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__rewardsReadbackReview.errors)).toEqual([]); });

async function startCreate(page: Page, title = 'Review reward') {
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill(title);
}
async function successfulToasts(page: Page) {
  return page.evaluate(() => window.__rewardsReadbackReview.toasts.filter(toast => toast.kind === 'success'));
}

test('repeated failed retries preserve the durable create without repeating completion or POST', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page);
  state.mode.rewards = 'fail';
  await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.evaluate(() => window.__rewardsReadbackReview.capture('Try again'));
  await page.evaluate(() => { void window.__rewardsReadbackReview.captured(); void window.__rewardsReadbackReview.captured(); });
  await finish(page); expect(await successfulToasts(page)).toEqual([]); expect(state.writes).toHaveLength(1);
  delete state.mode.rewards; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await successfulToasts(page)).toHaveLength(1);
  await page.evaluate(() => window.__rewardsReadbackReview.captured()); await finish(page);
  expect(await successfulToasts(page)).toHaveLength(1); expect(state.writes).toHaveLength(1);
});

test('access boundary retirement discards deferred completion before a new owner retries', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page);
  state.mode.rewards = 'fail'; await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.evaluate(() => window.__rewardsReadbackReview.capture('Try again'));
  delete state.mode.rewards; await mount(page, 'child'); await ready(page);
  await page.evaluate(() => window.__rewardsReadbackReview.captured()); await finish(page);
  expect(state.writes).toHaveLength(1); expect(await successfulToasts(page)).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('newer failed readback preserves a failed-write draft without creating a deferred success', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page);
  state.failMutation = true; await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__rewardsReadbackReview.toasts.length)).toBe(1);
  state.mode.rewards = 'fail'; await page.evaluate(() => window.__rewardsReadbackReview.online());
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  delete state.mode.rewards; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toHaveValue('Review reward');
  expect(await successfulToasts(page)).toEqual([]);
  state.failMutation = false; await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await successfulToasts(page)).toHaveLength(1);
  expect(state.rows.rewards.filter(row => row.title === 'Review reward')).toHaveLength(1);
});

test('superseding catalog readback error never completes until a usable retry', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page);
  state.mode.rewards = 'hold'; await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect.poll(() => state.reads.filter(table => table === 'rewards').length).toBe(2);
  await page.evaluate(() => window.__rewardsReadbackReview.online());
  await expect.poll(() => state.reads.filter(table => table === 'rewards').length).toBe(3);
  await state.releaseOne('rewards'); await finish(page);
  expect(await successfulToasts(page)).toEqual([]); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  state.mode.rewards = 'fail'; await state.releaseOne('rewards');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(await successfulToasts(page)).toEqual([]);
  delete state.mode.rewards; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await successfulToasts(page)).toHaveLength(1); expect(state.writes).toHaveLength(1);
});

for (const reopen of [false, true]) test(`a retained new-reward submit cannot create again after deferred completion${reopen ? ' and opening another form' : ''}`, async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page);
  await page.evaluate(() => window.__rewardsReadbackReview.captureSubmit());
  state.mode.rewards = 'fail'; await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  delete state.mode.rewards; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (reopen) await startCreate(page, 'Current review draft');
  await page.evaluate(() => window.__rewardsReadbackReview.capturedSubmit()); await finish(page);
  expect(state.rows.rewards.filter(row => row.title === 'Review reward')).toHaveLength(1);
  expect(state.writes).toHaveLength(1); expect(await successfulToasts(page)).toHaveLength(1);
  if (reopen) {
    await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toHaveValue('Current review draft');
    await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.rows.rewards.filter(row => row.title === 'Current review draft')).toHaveLength(1);
  }
});

test('a canceled form cannot submit its old fields after another form opens', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page); await startCreate(page, 'Canceled review draft');
  await page.evaluate(() => window.__rewardsReadbackReview.captureSubmit());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await startCreate(page, 'Current review draft');
  await page.evaluate(() => window.__rewardsReadbackReview.capturedSubmit()); await finish(page);
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toHaveValue('Current review draft');
});

