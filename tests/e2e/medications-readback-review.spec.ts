import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page, type Route } from '@playwright/test';

// These regressions replace medications-audit-repro.spec.ts after DATA-005
// was recorded. They verify this bounded UI repair, not production readiness.
// Actual MedicationsModule, query hook, cache boundary, adherence helper and shared form
// controls execute in Chromium. Installed Supabase/PostgREST performs the reads
// and writes against an intercepted, persisted fixture. Auth identity, realtime
// delivery, avatars and AI are controlled; no live database or medical data are used.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/modules/medications-module.tsx', 'lib/hooks/use-realtime-query.ts',
  'lib/offline/cache.ts', 'lib/offline/cache-scope.tsx', 'lib/auth/cache-session.ts', 'lib/auth/session-change.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts', 'lib/constants/roles.ts', 'lib/medications/adherence.ts',
  'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
  'components/ui/states.tsx', 'components/ui/states-client.tsx', 'components/ui/button.tsx',
  'components/ui/input.tsx', 'components/ui/modal.tsx', 'components/app/page-header.tsx',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(medications\.|medicationsModule\.|auth\.cache|states\.|modal\.)/.test(key)));
const origin = 'https://medications-audit-repro-fixture.invalid';
const provider = 'https://medications-audit-repro.supabase.co';
const familyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const childId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const parentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Table = 'medications' | 'medication_schedules' | 'medication_doses';
type Row = Record<string, unknown> & { id: string };
type Fixture = {
  rows: Record<Table, Row[]>;
  mode: Partial<Record<Table, 'fail' | 'hold'>>;
  reads: Table[];
  writes: Array<{ table: Table; method: string; body: Record<string, unknown> | null; query: string }>;
  holdMutations: boolean;
  failMutation: boolean;
  release: (table: Table) => Promise<void>;
  finishWrites: () => Promise<void>; releaseOne: (table: Table) => Promise<void>;
};
type Probe = {
  mount: (role?: 'child' | 'parent', family?: string) => void;
  unmount: () => void;
  seed: (table: Table, rows: Row[]) => void;
  online: () => void;
  settle: () => Promise<void>;
  saveHandler: () => void;
  captureSubmit: () => void;
  capture: (buttonText: string) => void;
  captured: () => Promise<void>;
  throwMutation: boolean;
  toasts: Array<{ kind: string; message: string }>;
  errors: string[];
};
declare global { interface Window { __medicationsReview: Probe } }

const medication: Row = { id: 'med-1', family_id: familyId, member_id: childId, name: 'Fixture medication', dosage: 'Recorded dosage', instructions: null, is_active: true, refill_on: null, refill_reminder_days: 7 };
const schedule: Row = { id: 'schedule-1', family_id: familyId, medication_id: medication.id, time_of_day: '08:00:00', days_of_week: [0,1,2,3,4,5,6], starts_on: '2026-01-01', ends_on: null };
const recorded: Row = { id: 'dose-1', family_id: familyId, medication_id: medication.id, schedule_id: schedule.id, member_id: childId, status: 'taken', scheduled_for: '2026-09-12T08:00:00.000Z', taken_at: '2026-09-12T08:05:00.000Z', logged_by: userId };
const otherFamily = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
test.use({ timezoneId: 'UTC' });

async function fixture(page: Page, locale: 'en-US' | 'fr-FR' = 'en-US'): Promise<Fixture> {
  const catalogue = locale === 'en-US' ? messages : Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(medications\.|medicationsModule\.|auth\.cache|states\.|modal\.)/.test(key)));
  const held = new Map<Table, Array<() => Promise<void>>>(), pendingWrites: Array<() => Promise<void>> = [];
  const state: Fixture = {
    rows: { medications: [{ ...medication }], medication_schedules: [{ ...schedule }], medication_doses: [] },
    mode: {}, reads: [], writes: [], holdMutations: false, failMutation: false,
    release: async table => { delete state.mode[table]; await Promise.all((held.get(table) ?? []).splice(0).map(release => release())); },
    releaseOne: async table => { await (held.get(table) ?? []).shift()?.(); },
    finishWrites: async () => { state.holdMutations = false; await Promise.all(pendingWrites.splice(0).map(release => release())); },
  };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  const read = (route: Route, table: Table) => route.fulfill({ status: state.mode[table] === 'fail' ? 403 : 200, headers, contentType: 'application/json',
    body: JSON.stringify(state.mode[table] === 'fail' ? { code: '42501', message: `Fixture ${table} read unavailable`, details: null, hint: null } : state.rows[table].filter(row => row.family_id === new URL(route.request().url()).searchParams.get('family_id')?.replace(/^eq\./, ''))) });
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
      if (table === 'medication_doses' && request.method() === 'POST' && state.rows[table].some(row => row.schedule_id === body?.schedule_id && row.scheduled_for === body?.scheduled_for)) {
        await route.fulfill({ status: 409, headers, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'Fixture unique dose slot conflict' }) }); return;
      }
      const matching = state.rows[table].filter(row => [...url.searchParams].every(([key, value]) =>
        key === 'select' || key === 'columns' || (value.startsWith('eq.') && String(row[key]) === value.slice(3))));
      if (request.method() !== 'POST' && url.searchParams.has('select') && matching.length !== 1) {
        await route.fulfill({ status: 406, headers, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'Fixture conditional write matched no row' }) }); return;
      }
      if (request.method() === 'POST') state.rows[table].push({ id: `written-${state.writes.length}`, created_at: new Date().toISOString(), ...body });
      else if (request.method() === 'PATCH') matching.forEach(row => Object.assign(row, body));
      else if (request.method() === 'DELETE') {
        state.rows[table] = state.rows[table].filter(row => !matching.includes(row));
        if (table === 'medications') {
          state.rows.medication_schedules = state.rows.medication_schedules.filter(row => !matching.some(med => med.id === row.medication_id));
          state.rows.medication_doses = state.rows.medication_doses.filter(row => !matching.some(med => med.id === row.medication_id));
        } else if (table === 'medication_schedules') state.rows.medication_doses.forEach(row => { if (matching.some(schedule => schedule.id === row.schedule_id)) row.schedule_id = null; });
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
    const p = window.__medicationsReview = { toasts: [], errors: [], throwMutation: false };
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
    const cache = load('@/lib/offline/cache'), Medications = load('@/components/modules/medications-module').MedicationsModule;
    const access = () => ({ userId, familyId: currentFamily, memberId: app().selfMember.id, membershipUpdatedAt: '2026-09-12T00:00:00Z', role, isSuperAdmin: false, planLevel: 2, featureTiers: {} });
    p.seed = (table, rows) => cache.writePartitionedCache(cache.cacheIdentity({ userId, sessionId, accessIdentity: cacheAccessKey(access()) }, table, familyId, table === 'medication_doses' ? [familyId, load('@/lib/medications/adherence').localDateKey(new Date())] : [familyId]), rows);
    let root;
    p.mount = (nextRole = 'parent', family = familyId) => { role = nextRole; currentFamily = family; root ??= ReactDOM.createRoot(document.getElementById('root')); ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale, source: 'default', messages }, React.createElement(AuthenticatedCacheBoundary, { access: access() }, React.createElement(Medications))))); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.online = () => window.dispatchEvent(new Event('online'));
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Invoke React's actual handler to cover its guards independently of the
    // disabled DOM control; retain it to simulate a delayed queued callback.
    function props(element) { return element[Object.keys(element).find(key => key.startsWith('__reactProps$'))]; }
    p.capture = text => { const button = [...document.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === text); if (!button) throw new Error('Missing fixture button: ' + text); const callback = props(button).onClick; p.captured = () => callback({ preventDefault() {} }); };
    p.saveHandler = () => props(document.querySelector('form')).onSubmit({ preventDefault() {} });
    p.captureSubmit = () => { const callback = props(document.querySelector('form')).onSubmit; p.captured = () => callback({ preventDefault() {} }); };
  })();` });
  return state;
}

const markTaken = (page: Page) => page.getByRole('button', { name: 'Mark taken', exact: true });
const skipDose = (page: Page) => page.getByRole('button', { name: 'Skip dose', exact: true });
async function mount(page: Page) { await page.evaluate(() => window.__medicationsReview.mount()); }
async function ready(page: Page) { await expect(markTaken(page)).toBeVisible(); }
async function settled(page: Page) { await page.evaluate(() => window.__medicationsReview.settle()); }
test('review: superseded mutation readback keeps actions blocked until current rows commit', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.mode.medication_doses = 'hold';
  await markTaken(page).click();
  await expect.poll(() => state.reads.filter(table => table === 'medication_doses').length).toBe(2);
  await page.evaluate(() => window.__medicationsReview.online());
  await expect.poll(() => state.reads.filter(table => table === 'medication_doses').length).toBe(3);
  await state.releaseOne('medication_doses');
  await settled(page);
  expect(state.rows.medication_doses).toHaveLength(1);
  await expect(markTaken(page)).toBeDisabled({ timeout: 1000 });
  expect(await page.evaluate(() => window.__medicationsReview.toasts)).toEqual([]);
  await state.release('medication_doses');
  await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  await expect(markTaken(page)).toBeEnabled();
});

test('newer failed readback requires explicit recovery before another dose action', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.mode.medication_doses = 'hold'; await markTaken(page).click();
  await expect.poll(() => state.reads.filter(table => table === 'medication_doses').length).toBe(2);
  await page.evaluate(() => window.__medicationsReview.online());
  await expect.poll(() => state.reads.filter(table => table === 'medication_doses').length).toBe(3);
  await state.releaseOne('medication_doses');
  state.mode.medication_doses = 'fail'; await state.releaseOne('medication_doses');
  await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__medicationsReview.toasts)).toEqual([]);
  await expect(markTaken(page)).toHaveCount(0);
  delete state.mode.medication_doses;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('retiring the owner while confirmed readback waits cannot release or toast into the next owner', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.mode.medication_doses = 'hold'; await markTaken(page).click();
  await expect.poll(() => state.reads.filter(table => table === 'medication_doses').length).toBe(2);
  await page.evaluate(family => window.__medicationsReview.mount('parent', family), otherFamily);
  await state.release('medication_doses'); await settled(page);
  expect(await page.evaluate(() => window.__medicationsReview.toasts)).toEqual([]);
  await expect(page.getByText('Fixture medication', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('confirmed medication creation retires its form after failed readback is recovered', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Confirmed medication');
  await page.evaluate(() => window.__medicationsReview.captureSubmit());
  state.mode.medications = 'fail';
  await page.getByRole('dialog').getByRole('button', { name: 'Add medication', exact: true }).click();
  await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
  expect(state.rows.medications).toHaveLength(2);
  expect(await page.evaluate(() => window.__medicationsReview.toasts)).toEqual([]);
  delete state.mode.medications;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Confirmed medication', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.__medicationsReview.captured());
  expect(state.writes.filter(write => write.table === 'medications')).toHaveLength(1);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('');
  await page.evaluate(() => window.__medicationsReview.captured());
  expect(state.writes.filter(write => write.table === 'medications')).toHaveLength(1);
});

test('confirmed schedule creation retires its form after failed readback is recovered', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Time of day').fill('09:00');
  await page.evaluate(() => window.__medicationsReview.captureSubmit());
  state.mode.medication_schedules = 'fail';
  await page.getByRole('dialog').getByRole('button', { name: 'Add schedule', exact: true }).click();
  await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
  expect(state.rows.medication_schedules).toHaveLength(2);
  expect(await page.evaluate(() => window.__medicationsReview.toasts)).toEqual([]);
  delete state.mode.medication_schedules;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(markTaken(page)).toHaveCount(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.__medicationsReview.captured());
  expect(state.writes.filter(write => write.table === 'medication_schedules')).toHaveLength(1);
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.evaluate(() => window.__medicationsReview.captured());
  expect(state.writes.filter(write => write.table === 'medication_schedules')).toHaveLength(1);
});

for (const kind of ['medication', 'schedule'] as const) {
  for (const ending of ['cancel', 'success'] as const) {
    test(`${kind} submit is retired after ${ending} and cannot act on a later opening`, async ({ page }) => {
      const state = await fixture(page); await mount(page); await ready(page);
      const label = kind === 'medication' ? 'Add medication' : 'Add schedule';
      const table = kind === 'medication' ? 'medications' : 'medication_schedules';
      await page.getByRole('button', { name: label, exact: true }).click();
      if (kind === 'medication') await page.getByRole('textbox', { name: /^Name/ }).fill('Retired opening');
      else await page.getByLabel('Time of day').fill('09:00');
      await page.evaluate(() => window.__medicationsReview.captureSubmit());
      await page.getByRole('dialog').getByRole('button', { name: ending === 'cancel' ? 'Cancel' : label, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const writes = ending === 'cancel' ? 0 : 1;
      await page.evaluate(() => window.__medicationsReview.captured());
      expect(state.writes.filter(write => write.table === table)).toHaveLength(writes);
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.evaluate(() => window.__medicationsReview.captured());
      expect(state.writes.filter(write => write.table === table)).toHaveLength(writes);
      // The new opening is writable through its own actual form handler.
      if (kind === 'medication') await page.getByRole('textbox', { name: /^Name/ }).fill('Current opening');
      else await page.getByLabel('Time of day').fill('10:00');
      await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(state.writes.filter(write => write.table === table)).toHaveLength(writes + 1);
    });
  }
}

test('a rejected schedule write preserves the same opening for explicit retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Time of day').fill('09:30');
  await page.evaluate(() => window.__medicationsReview.captureSubmit());
  state.failMutation = true;
  await page.evaluate(() => window.__medicationsReview.captured());
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Time of day')).toHaveValue('09:30');
  expect(state.rows.medication_schedules).toHaveLength(1);
  state.failMutation = false;
  await page.evaluate(() => window.__medicationsReview.captured());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.rows.medication_schedules).toHaveLength(2);
  expect(state.rows.medication_schedules[1].time_of_day).toBe('09:30');
  expect(state.writes.filter(write => write.table === 'medication_schedules')).toHaveLength(2);
});
