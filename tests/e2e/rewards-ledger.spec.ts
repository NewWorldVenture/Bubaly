import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page, type Route } from '@playwright/test';

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
const origin = 'https://rewards-ledger-fixture.invalid';
const provider = 'https://rewards-ledger.supabase.co';
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
  finishWrites: () => Promise<void>;
};
type Probe = {
  mount: (role?: 'child' | 'parent') => void;
  unmount: () => void;
  seed: (table: Table, rows: Row[]) => void;
  online: () => void;
  settle: () => Promise<void>;
  saveHandler: () => void;
  capture: (buttonText: string) => void;
  captured: () => Promise<void>;
  throwMutation: boolean;
  toasts: Array<{ kind: string; message: string }>;
  errors: string[];
};
declare global { interface Window { __rewardsLedger: Probe } }

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
    const p = window.__rewardsLedger = { toasts: [], errors: [], throwMutation: false };
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
  })();` });
  return state;
}
async function mount(page: Page, role: 'child' | 'parent' = 'child') { await page.evaluate(role => window.__rewardsLedger.mount(role), role); }
async function ready(page: Page) { await expect(page.getByText('Points Leaderboard', { exact: true })).toBeVisible(); }
async function finish(page: Page) { await page.evaluate(() => window.__rewardsLedger.settle()); }
async function noWrites(state: Fixture) { expect(state.writes).toEqual([]); }
test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__rewardsLedger.errors)).toEqual([]); });

for (const table of ['rewards', 'chore_assignments', 'reward_redemptions'] as const) {
  test(`${table} failure reports an error, prevents redemption and retries to verified zero balance`, async ({ page }) => {
    const state = await fixture(page); state.mode[table] = 'fail'; await mount(page);
    await expect(page.getByText(/permission to do that/)).toBeVisible();
    await expect(page.getByText('Points Leaderboard', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toHaveCount(0); await noWrites(state);
    delete state.mode[table]; const reads = state.reads.length;
    await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
    await expect(page.getByRole('button', { name: 'Not enough points', exact: true })).toBeDisabled();
    expect(new Set(state.reads.slice(reads))).toEqual(new Set(['rewards', 'chore_assignments', 'reward_redemptions']));
    await noWrites(state);
  });

  for (const cached of [false, true]) test(`${table} ${cached ? 'cached rows awaiting validation' : 'pending read'} cannot authorize a redemption`, async ({ page }) => {
    const state = await fixture(page); state.mode[table] = 'hold';
    if (cached) await page.evaluate(({ table, rows }) => window.__rewardsLedger.seed(table, rows), { table, rows: state.rows[table] });
    await mount(page); await expect.poll(() => state.reads.includes(table)).toBe(true); await finish(page);
    await expect(page.getByText('Points Leaderboard', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toHaveCount(0); await noWrites(state);
    await state.release(table); await ready(page);
    await expect(page.getByRole('button', { name: 'Not enough points', exact: true })).toBeDisabled();
  });
}

test('a retained redemption callback cannot write after a required ledger refresh fails', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = []; await mount(page); await ready(page);
  await page.evaluate(() => window.__rewardsLedger.capture('Redeem'));
  state.mode.reward_redemptions = 'fail'; await page.evaluate(() => window.__rewardsLedger.online());
  await expect(page.getByText(/permission to do that/)).toBeVisible();
  await page.evaluate(() => window.__rewardsLedger.captured()); await finish(page); await noWrites(state);
});

test('sufficient verified points create one request despite same-turn duplicate callbacks and refresh its readback', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = []; state.holdMutations = true;
  await mount(page); await ready(page); await page.evaluate(() => window.__rewardsLedger.capture('Redeem'));
  const reads = state.reads.length;
  await page.evaluate(() => { void window.__rewardsLedger.captured(); void window.__rewardsLedger.captured(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toBeDisabled();
  await state.finishWrites(); await expect.poll(() => state.reads.length).toBeGreaterThan(reads + 1);
  expect(state.rows.reward_redemptions).toHaveLength(1);
  expect(state.rows.reward_redemptions[0]).toMatchObject({ member_id: childId, reward_title: 'Movie night', cost_points: 100, status: 'requested' });
  expect(new Set(state.reads.slice(reads))).toEqual(new Set(['chore_assignments', 'reward_redemptions']));
});

test('manager request, approval and fulfillment use persisted readback and update spendable points', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = []; await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Redeem', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  expect(state.rows.reward_redemptions[0]).toMatchObject({ status: 'requested', member_id: childId });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark fulfilled', exact: true })).toBeVisible();
  expect(state.rows.reward_redemptions[0]).toMatchObject({ status: 'approved', decided_by: parentId });
  await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Mark fulfilled', exact: true }).click();
  await expect(page.getByText('Fulfilled', { exact: true })).toBeVisible();
  expect(state.rows.reward_redemptions[0]).toMatchObject({ status: 'fulfilled', decided_by: parentId });
  expect(state.writes.map(write => write.method)).toEqual(['POST', 'PATCH', 'PATCH']);
});

test('manager rejects a request and the refreshed history does not spend its points', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = [{ ...requested }]; await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toBeEnabled();
  expect(state.rows.reward_redemptions[0]).toMatchObject({ status: 'rejected', decided_by: parentId });
});

test('catalog create, edit, cancel and confirmed delete reconcile unpublished rows', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('Park picnic');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await noWrites(state);
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('Park picnic');
  await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Park picnic', { exact: true })).toBeVisible();
  const card = page.getByText('Park picnic', { exact: true }).locator('..');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('Beach picnic');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Beach picnic', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByText('Beach picnic', { exact: true }).locator('..').getByRole('button', { name: 'Delete', exact: true }).click();
  expect(state.writes).toHaveLength(2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByText('Beach picnic', { exact: true }).locator('..').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Beach picnic', { exact: true })).toHaveCount(0);
  expect(state.rows.rewards.map(row => row.title)).toEqual(['Movie night']);
  expect(state.writes.map(write => write.method)).toEqual(['POST', 'PATCH', 'DELETE']);
});

test('a catalog draft survives a failed ledger refresh and retry', async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('Unfinished reward');
  state.mode.chore_assignments = 'fail'; await page.evaluate(() => window.__rewardsLedger.online());
  await expect(page.getByText(/permission to do that/)).toBeVisible(); await noWrites(state);
  delete state.mode.chore_assignments; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toHaveValue('Unfinished reward');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await noWrites(state);
});

for (const throws of [false, true]) test(`a ${throws ? 'thrown' : 'returned'} mutation failure preserves the draft and permits retry`, async ({ page }) => {
  const state = await fixture(page); await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('Retry reward');
  state.failMutation = !throws;
  if (throws) await page.evaluate(() => { window.__rewardsLedger.throwMutation = true; });
  await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__rewardsLedger.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toHaveValue('Retry reward');
  state.failMutation = false;
  await page.getByRole('dialog').getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Retry reward', { exact: true })).toBeVisible();
  expect(state.rows.rewards.filter(row => row.title === 'Retry reward')).toHaveLength(1);
});

test('a pending catalog save blocks duplicate submit and cancel until its confirmed readback', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page, 'parent'); await ready(page);
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reward*', exact: true }).fill('One saved reward');
  await page.evaluate(() => { void window.__rewardsLedger.saveHandler(); void window.__rewardsLedger.saveHandler(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Reward*', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await state.finishWrites();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('One saved reward', { exact: true })).toBeVisible();
  expect(state.rows.rewards.filter(row => row.title === 'One saved reward')).toHaveLength(1);
});

test('a retained approval callback rechecks the current verified balance before writing', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = [{ ...requested }]; await mount(page, 'parent'); await ready(page);
  await page.evaluate(() => window.__rewardsLedger.capture('Approve'));
  state.rows.reward_redemptions.push({ ...spent }); await page.evaluate(() => window.__rewardsLedger.online());
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__rewardsLedger.captured()); await finish(page); await noWrites(state);
  expect(state.rows.reward_redemptions.find(row => row.id === requested.id)?.status).toBe('requested');
});

test('a committed request with failed ledger readback stays unavailable until a successful retry', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = []; await mount(page, 'parent'); await ready(page);
  state.mode.reward_redemptions = 'fail';
  await page.getByRole('button', { name: 'Redeem', exact: true }).click();
  await expect(page.getByText(/permission to do that/)).toBeVisible();
  expect(state.rows.reward_redemptions).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Redeem', exact: true })).toHaveCount(0);
  delete state.mode.reward_redemptions; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('unmount retires callbacks and a late issued-write completion does not refresh or toast', async ({ page }) => {
  const state = await fixture(page); state.rows.reward_redemptions = []; state.holdMutations = true;
  await mount(page); await ready(page); await page.evaluate(() => window.__rewardsLedger.capture('Redeem'));
  await page.getByRole('button', { name: 'Redeem', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  const reads = state.reads.length;
  await page.evaluate(() => window.__rewardsLedger.unmount());
  await state.finishWrites(); await finish(page);
  await page.evaluate(() => window.__rewardsLedger.captured()); await finish(page);
  expect(state.writes).toHaveLength(1);
  expect(state.rows.reward_redemptions).toHaveLength(1);
  expect(state.reads).toHaveLength(reads);
  expect(await page.evaluate(() => window.__rewardsLedger.toasts)).toEqual([]);
  await expect(page.locator('main')).toBeEmpty();
});
