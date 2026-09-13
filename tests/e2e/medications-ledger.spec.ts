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
  // adherence.ts resolves a dose slot in the family's zone; the in-page loader
  // below throws on any module missing from this list, so its imports belong here.
  'lib/time/zoned.ts',
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
  finishWrites: () => Promise<void>;
};
type Probe = {
  mount: (role?: 'child' | 'parent', family?: string) => void;
  /** The FAMILY's zone, which is what resolves a dose slot to an instant. */
  timezone: (zone: string) => void;
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
declare global { interface Window { __medicationsAudit: Probe } }

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
    const p = window.__medicationsAudit = { toasts: [], errors: [], throwMutation: false };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let currentFamily = ${JSON.stringify(familyId)}, familyTimezone = 'UTC'; const familyId = ${JSON.stringify(familyId)}, userId = ${JSON.stringify(userId)}, sessionId = '11111111-1111-4111-8111-111111111111';
    const members = [{ id: ${JSON.stringify(childId)}, family_id: familyId, user_id: userId, display_name: 'Casey', role: 'child' },
      { id: ${JSON.stringify(parentId)}, family_id: familyId, user_id: userId, display_name: 'Alex', role: 'parent' }];
    let role = 'parent';
    const app = () => {
      const currentMembers = members.map(member => ({ ...member, family_id: currentFamily,
        id: currentFamily === familyId ? member.id : member.role === 'parent' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : '99999999-9999-4999-8999-999999999999' }));
      // The real context always carries the family, and the module reads its
      // timezone to resolve a dose slot. UTC is the default because that is what
      // this fixture already assumes: its recorded doses are stamped at the
      // 08:00 slot as 08:00Z. A test that cares about the family's own clock
      // sets it with p.timezone before mounting.
      // (No backticks in here - this whole block is a template literal.)
      return { familyId: currentFamily, userId, family: { id: currentFamily, name: 'Fixture family', timezone: familyTimezone },
        members: currentMembers, selfMember: currentMembers.find(member => member.role === role), role };
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
    p.timezone = (zone) => { familyTimezone = zone; };
    p.mount = (nextRole = 'parent', family = familyId) => { role = nextRole; currentFamily = family; root ??= ReactDOM.createRoot(document.getElementById('root')); ReactDOM.flushSync(() => root.render(React.createElement(LocaleProvider, { locale, source: 'default', messages }, React.createElement(AuthenticatedCacheBoundary, { access: access() }, React.createElement(Medications))))); };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.online = () => window.dispatchEvent(new Event('online'));
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Invoke React's actual handler to cover its guards independently of the
    // disabled DOM control; retain it to simulate a delayed queued callback.
    function props(element) { return element[Object.keys(element).find(key => key.startsWith('__reactProps$'))]; }
    p.capture = text => { const button = [...document.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === text); if (!button) throw new Error('Missing fixture button: ' + text); const callback = props(button).onClick; p.captured = () => callback({ preventDefault() {} }); };
    p.saveHandler = () => props(document.querySelector('form')).onSubmit({ preventDefault() {} });
  })();` });
  return state;
}

const markTaken = (page: Page) => page.getByRole('button', { name: 'Mark taken', exact: true });
const skipDose = (page: Page) => page.getByRole('button', { name: 'Skip dose', exact: true });
async function mount(page: Page) { await page.evaluate(() => window.__medicationsAudit.mount()); }
async function ready(page: Page) { await expect(markTaken(page)).toBeVisible(); }
async function settled(page: Page) { await page.evaluate(() => window.__medicationsAudit.settle()); }
test.afterEach(async ({ page }) => {
  const errors = await page.evaluate(() => window.__medicationsAudit.errors);
  expect(errors).toEqual([]);
});

for (const table of ['medications', 'medication_schedules', 'medication_doses'] as const) {
  test(`control: ${table} initial read failure withholds dosing actions and recovers on retry`, async ({ page }) => {
    const state = await fixture(page); state.mode[table] = 'fail'; await mount(page);
    await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
    await expect(markTaken(page)).toHaveCount(0); expect(state.writes).toEqual([]);
    delete state.mode[table]; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page);
    expect(state.writes).toEqual([]);
  });
  test(`control: ${table} initial pending read without cache withholds dosing actions`, async ({ page }) => {
    const state = await fixture(page); state.mode[table] = 'hold'; await mount(page);
    await expect.poll(() => state.reads.includes(table)).toBe(true); await settled(page);
    await expect(markTaken(page)).toHaveCount(0); expect(state.writes).toEqual([]);
    await state.release(table); await ready(page);
  });
}

test('successful dose readback shows taken and a second intentional toggle removes the same slot', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  const reads = state.reads.length; await markTaken(page).click();
  await expect.poll(() => state.rows.medication_doses.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.some(toast => toast.kind === 'success'))).toBe(true);
  await expect(markTaken(page)).toHaveClass(/bg-emerald-500/);
  await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  expect(state.reads.length).toBeGreaterThan(reads);
  expect(state.writes[0].body).toMatchObject({ family_id: familyId, member_id: childId, medication_id: medication.id,
    schedule_id: schedule.id, logged_by: userId, scheduled_for: '2026-09-12T08:00:00.000Z', status: 'taken' });
  await markTaken(page).click(); await expect.poll(() => state.writes.length).toBe(2);
  await expect(page.getByText('0 taken', { exact: true })).toBeVisible();
  expect(state.writes.map(write => write.method)).toEqual(['POST', 'DELETE']);
  expect(state.rows.medication_doses).toHaveLength(0);
});

test('taken to skipped to taken uses persisted readback and updates the existing record', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; await mount(page); await ready(page);
  await expect(markTaken(page)).toHaveClass(/bg-emerald-500/);
  await skipDose(page).click(); await expect.poll(() => state.rows.medication_doses[0].status).toBe('skipped');
  await expect(skipDose(page)).toBeEnabled();
  await expect(skipDose(page)).toHaveClass(/bg-amber-500/);
  await markTaken(page).click(); await expect.poll(() => state.rows.medication_doses[0].status).toBe('taken');
  await expect(markTaken(page)).toHaveClass(/bg-emerald-500/);
  expect(state.writes.map(write => write.method)).toEqual(['PATCH', 'PATCH']);
  expect(state.writes.every(write => write.query.includes('family_id'))).toBe(true);
});

test('same-turn dose callbacks send one write while one is still pending', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page); await ready(page);
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await page.evaluate(() => { void window.__medicationsAudit.captured(); void window.__medicationsAudit.captured(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(markTaken(page)).toBeDisabled(); await state.finishWrites();
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.length)).toBe(1);
  expect(state.rows.medication_doses).toHaveLength(1);
});

test('cached empty dose history cannot authorize an insert before the authoritative read returns', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; state.mode.medication_doses = 'hold';
  await page.evaluate(({ medication, schedule }) => {
    window.__medicationsAudit.seed('medications', [medication]);
    window.__medicationsAudit.seed('medication_schedules', [schedule]);
    window.__medicationsAudit.seed('medication_doses', []);
  }, { medication, schedule });
  await mount(page); await expect.poll(() => state.reads.includes('medication_doses')).toBe(true); await settled(page);
  await expect(markTaken(page)).toHaveCount(0); expect(state.writes).toEqual([]);
  expect(state.rows.medication_doses).toHaveLength(1); expect(state.rows.medication_doses[0].id).toBe(recorded.id);
  await state.release('medication_doses'); await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
});

test('thrown dose mutation is contained and restores controls after readback', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.evaluate(() => { window.__medicationsAudit.throwMutation = true; });
  await markTaken(page).click();
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  await expect(markTaken(page)).toBeEnabled(); await expect(skipDose(page)).toBeEnabled();
  expect(state.writes).toEqual([]);
  await markTaken(page).click(); await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
});

test('marking inactive immediately retires dosing actions and a retained callback cannot log it', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await page.getByRole('button', { name: 'Mark inactive', exact: true }).click();
  await expect.poll(() => state.rows.medications[0].is_active).toBe(false);
  await expect(page.getByRole('button', { name: 'Reactivate', exact: true })).toBeVisible();
  await expect(markTaken(page)).toHaveCount(0);
  await page.evaluate(() => window.__medicationsAudit.captured());
  expect(state.rows.medication_doses).toEqual([]); expect(state.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Reactivate', exact: true }).click(); await ready(page);
});

test('retained owner-A dose callback cannot write after the cache boundary switches to family B', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await page.evaluate(family => window.__medicationsAudit.mount('parent', family), otherFamily);
  await expect(page.getByText('No medications yet', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__medicationsAudit.captured());
  expect(state.writes).toEqual([]);
  expect(await page.evaluate(() => window.__medicationsAudit.toasts)).toEqual([]);
  await expect(page.getByText('No medications yet', { exact: true })).toBeVisible();
});

test('after midnight a retained previous-day callback is rejected and the new action uses the current slot', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await page.clock.setFixedTime(new Date('2026-09-13T12:00:00.000Z'));
  await page.evaluate(() => window.__medicationsAudit.captured());
  expect(state.writes).toEqual([]);
  await settled(page); await ready(page);
  await markTaken(page).click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body?.scheduled_for).toBe('2026-09-13T08:00:00.000Z');
  expect(state.writes[0].body?.taken_at).toBe('2026-09-13T12:00:00.000Z');
});

test('control: a returned dose-write failure preserves the log and restores the controls for retry', async ({ page }) => {
  const state = await fixture(page); state.failMutation = true; await mount(page); await ready(page);
  await markTaken(page).click();
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  expect(state.rows.medication_doses).toEqual([]); await expect(markTaken(page)).toBeEnabled();
  state.failMutation = false; await markTaken(page).click();
  await expect.poll(() => state.rows.medication_doses.length).toBe(1);
});

test('successful medication creation reads back and shows the persisted medication', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Second fixture medication');
  const reads = state.reads.length;
  await page.getByRole('dialog').getByRole('button', { name: 'Add medication', exact: true }).click();
  await expect.poll(() => state.rows.medications.length).toBe(2); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.reads.length).toBeGreaterThan(reads);
  await expect(page.getByText('Second fixture medication', { exact: true })).toBeVisible();
});

test('successful schedule creation reads back the new actionable dose', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.locator('input[type="time"]').fill('09:45');
  const reads = state.reads.length;
  await page.getByRole('dialog').getByRole('button', { name: 'Add schedule', exact: true }).click();
  await expect.poll(() => state.rows.medication_schedules.length).toBe(2); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.reads.length).toBeGreaterThan(reads);
  await expect(markTaken(page)).toHaveCount(2);
});

test('a committed dose keeps actions blocked until its held readback returns', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.mode.medication_doses = 'hold';
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await markTaken(page).click(); await expect.poll(() => state.rows.medication_doses.length).toBe(1);
  await expect(markTaken(page)).toBeDisabled();
  await page.evaluate(() => window.__medicationsAudit.captured()); expect(state.writes).toHaveLength(1);
  await state.release('medication_doses'); await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  await expect(markTaken(page)).toBeEnabled();
});

test('a committed dose with failed readback withholds actions until retry confirms the saved row', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.mode.medication_doses = 'fail'; await markTaken(page).click();
  await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
  expect(state.rows.medication_doses).toHaveLength(1); await expect(markTaken(page)).toHaveCount(0);
  delete state.mode.medication_doses; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('1 taken', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
});

test('a medication draft survives required-read failure and retry', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Preserved draft');
  state.mode.medication_schedules = 'fail'; await page.evaluate(() => window.__medicationsAudit.online());
  await expect(page.getByText('Could not load medication data. Refresh and try again.', { exact: true })).toBeVisible();
  delete state.mode.medication_schedules; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Preserved draft');
  expect(state.writes).toEqual([]);
});

for (const failure of ['returned', 'thrown'] as const) test(`${failure} medication-save failure retains the draft for an explicit retry`, async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Retained save');
  if (failure === 'returned') state.failMutation = true;
  else await page.evaluate(() => { window.__medicationsAudit.throwMutation = true; });
  await page.getByRole('dialog').getByRole('button', { name: 'Add medication', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Retained save');
  state.failMutation = false;
  await page.getByRole('dialog').getByRole('button', { name: 'Add medication', exact: true }).click();
  await expect(page.getByText('Retained save', { exact: true })).toBeVisible();
  expect(state.rows.medications).toHaveLength(2);
});

test('pending medication save cannot be duplicated or falsely canceled before the acknowledgement', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Add medication', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('One saved medication');
  await page.evaluate(() => { void window.__medicationsAudit.saveHandler(); void window.__medicationsAudit.saveHandler(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Name/ })).toBeDisabled();
  await state.finishWrites(); await expect(page.getByText('One saved medication', { exact: true })).toBeVisible();
  expect(state.rows.medications).toHaveLength(2);
});

test('a late acknowledged owner-A write does not read back or toast into the newly mounted family B', async ({ page }) => {
  const state = await fixture(page); state.holdMutations = true; await mount(page); await ready(page);
  await markTaken(page).click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.evaluate(family => window.__medicationsAudit.mount('parent', family), otherFamily);
  await expect(page.getByText('No medications yet', { exact: true })).toBeVisible();
  const reads = state.reads.length; await state.finishWrites(); await settled(page);
  expect(state.rows.medication_doses).toHaveLength(1); expect(state.reads).toHaveLength(reads);
  expect(await page.evaluate(() => window.__medicationsAudit.toasts)).toEqual([]);
});

test('a concurrent dose status change cannot be deleted using the earlier taken status', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; await mount(page); await ready(page);
  state.rows.medication_doses[0].status = 'skipped';
  await markTaken(page).click();
  await expect(skipDose(page)).toHaveClass(/bg-amber-500/);
  expect(state.rows.medication_doses).toHaveLength(1); expect(state.rows.medication_doses[0].status).toBe('skipped');
  expect(state.writes[0].query).toContain('status=eq.taken');
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.some(toast => toast.kind === 'error'))).toBe(true);
});

test('a concurrent unique-slot insert is read back without creating a duplicate row', async ({ page }) => {
  const state = await fixture(page); await mount(page); await ready(page);
  state.rows.medication_doses = [{ ...recorded }]; await markTaken(page).click();
  await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  expect(state.rows.medication_doses).toHaveLength(1); expect(state.rows.medication_doses[0].id).toBe(recorded.id);
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.map(toast => toast.message))).toContain('This dose changed. Refresh and review it before logging.');
});

test('moving a schedule later on the same day preserves the earlier recorded dose', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; await mount(page); await ready(page);
  state.rows.medication_schedules[0].time_of_day = '10:30:00'; await page.evaluate(() => window.__medicationsAudit.online());
  await expect(page.getByText('10:30', { exact: true })).toHaveCount(2);
  await expect(markTaken(page)).not.toHaveClass(/bg-emerald-500/);
  await markTaken(page).click(); await expect.poll(() => state.rows.medication_doses.length).toBe(2);
  expect(state.rows.medication_doses.map(row => row.scheduled_for)).toEqual(['2026-09-12T08:00:00.000Z', '2026-09-12T10:30:00.000Z']);
  expect(state.rows.medication_doses[0]).toMatchObject(recorded);
});

test('an existing dose assigned to another member is preserved rather than toggled', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded, member_id: parentId }]; await mount(page); await ready(page);
  await expect(markTaken(page)).toBeDisabled(); await expect(markTaken(page)).not.toHaveClass(/bg-emerald-500/);
  await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
  await page.evaluate(() => window.__medicationsAudit.captured()); expect(state.writes).toEqual([]);
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.map(toast => toast.message))).toContain('This dose changed. Refresh and review it before logging.');
  expect(state.rows.medication_doses[0].member_id).toBe(parentId);
});

test.describe('unresolvable local clock slot', () => {
  test.use({ timezoneId: 'America/New_York' });
  // The gap that matters is the FAMILY's, not the viewer's: 02:30 on 2026-03-08
  // never happens in New York, so a household there cannot have taken that dose.
  // The browser also sits in New York, which is the ordinary case — a member at
  // home. What changed is which clock decides, and the family's is the answer.
  test('the spring DST gap remains visible for review and cannot be logged at a silently shifted time', async ({ page }) => {
    const state = await fixture(page); state.rows.medication_schedules[0].time_of_day = '02:30:00';
    await page.evaluate(() => window.__medicationsAudit.timezone('America/New_York'));
    await page.clock.setFixedTime(new Date('2026-03-08T12:00:00.000Z')); await mount(page); await ready(page);
    await expect(markTaken(page)).toBeDisabled();
    await expect(page.getByText('This dose changed. Refresh and review it before logging.', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__medicationsAudit.capture('Mark taken'));
    await page.evaluate(() => window.__medicationsAudit.captured()); expect(state.writes).toEqual([]);
  });
});

test('actual French locale provider renders a dose conflict without replacing the existing record', async ({ page }) => {
  const french = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  const state = await fixture(page, 'fr-FR'); await mount(page);
  const button = page.getByRole('button', { name: french['medications.markTaken'], exact: true });
  await expect(button).toBeVisible(); state.rows.medication_doses = [{ ...recorded }]; await button.click();
  await expect.poll(() => page.evaluate(() => window.__medicationsAudit.toasts.map(toast => toast.message))).toContain(french['medicationsModule.doseChanged']);
  await expect(button).toHaveClass(/bg-emerald-500/);
  expect(state.rows.medication_doses).toHaveLength(1); expect(state.rows.medication_doses[0].id).toBe(recorded.id);
});

test('medication edit and confirmed delete read back the saved name and the dependent rows', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Updated fixture medication');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Updated fixture medication', { exact: true })).toHaveCount(1);
  expect(state.rows.medications[0].dosage).toBe(medication.dosage);
  expect(state.rows.medication_doses[0]).toMatchObject(recorded);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No medications yet', { exact: true })).toBeVisible();
  expect(state.rows.medication_schedules).toEqual([]); expect(state.rows.medication_doses).toEqual([]);
  expect(state.writes.every(write => write.query.includes('family_id'))).toBe(true);
});

test('schedule removal retires its actionable dose while retaining its logged history', async ({ page }) => {
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }]; await mount(page); await ready(page);
  await page.getByRole('button', { name: 'Remove schedule', exact: true }).click();
  await expect(markTaken(page)).toHaveCount(0); await expect(page.getByText('1 taken', { exact: true })).toBeVisible();
  expect(state.rows.medication_schedules).toEqual([]);
  expect(state.rows.medication_doses[0]).toMatchObject({ ...recorded, schedule_id: null });
  expect(state.writes[0].query).toContain('family_id');
});

test('the periodic day check advances an open page across midnight without a user action', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page); state.rows.medication_doses = [{ ...recorded }];
  await page.clock.setSystemTime(new Date('2026-09-12T23:59:30.000Z')); await mount(page); await ready(page);
  await expect(markTaken(page)).toHaveClass(/bg-emerald-500/);
  await page.clock.runFor(60_001);
  await expect(markTaken(page)).not.toHaveClass(/bg-emerald-500/);
  await markTaken(page).click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body?.scheduled_for).toBe('2026-09-13T08:00:00.000Z');
});
