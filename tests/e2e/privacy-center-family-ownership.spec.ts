import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual PrivacyCenter, React, role predicates, settleAll and installed SDK
// execute in Chromium. HTTP rows model a user who manages both families, as
// trust_audit_read permits; Auth, formatting and UI wrappers are peripheral
// stand-ins. This is component/query acceptance, not live Auth/RLS acceptance.
// AppProvider normally remounts its subtree when the access identity changes;
// the retained-component cases below additionally defend this component alone.
const { react, reactDom } = reactBrowserScripts('production');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const sources = Object.fromEntries([
  'components/settings/privacy-center.tsx', 'lib/constants/roles.ts', 'lib/supabase/settle.ts',
].map(file => [file, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const origin = 'https://privacy-family-fixture.invalid';
const provider = 'https://privacy-family-fixture.supabase.co';
type Row = { id: string; family_id: string; actor_kind: string; actor_id: string; domain: string; capability: string; decision: string; reason: string; created_at: string };
const row = (family: string, exported = false): Row => ({
  id: `${family}-${exported ? 'export' : 'access'}`, family_id: family,
  actor_kind: 'member', actor_id: `member-${family}`, domain: exported ? 'privacy' : 'documents',
  capability: exported ? 'export' : 'read', decision: 'executed',
  reason: `${family} private history`, created_at: '2026-10-13T14:00:00Z',
});
type State = { rows: Row[]; queries: URL[]; holdA: boolean; release: Array<() => Promise<void>>; fail: boolean; unexpected: string[]; errors: string[] };
type Probe = { render: (patch: { familyId?: string; role?: string; userId?: string }) => string; settle: () => Promise<void>; rejections: string[] };
declare global { interface Window { __privacyFamily: Probe } }
const fixtureStates = new WeakMap<Page, State>();

async function install(page: Page, options: { rows?: Row[]; role?: string; holdA?: boolean; fail?: boolean } = {}): Promise<State> {
  const state: State = { rows: options.rows ?? [row('family-A'), row('family-B'), row('family-A', true), row('family-B', true)], queries: [], holdA: options.holdA ?? false, release: [], fail: options.fail ?? false, unexpected: [], errors: [] };
  fixtureStates.set(page, state);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }); return;
    }
    if (url.origin !== provider || url.pathname !== '/rest/v1/trust_audit_logs' || route.request().method() !== 'GET') {
      state.unexpected.push(route.request().url()); await route.abort(); return;
    }
    state.queries.push(url);
    const filter = url.searchParams.get('family_id');
    const exported = url.searchParams.get('capability') === 'eq.export';
    // Capture at request time: a delayed A reply remains A after a switch.
    const body = state.rows.filter(item => (!filter || `eq.${item.family_id}` === filter) && (!exported || (item.domain === 'privacy' && item.capability === 'export'))).slice(0, Number(url.searchParams.get('limit')));
    const reply = () => route.fulfill({ status: state.fail ? 400 : 200, contentType: 'application/json', body: JSON.stringify(state.fail ? { code: '42501', message: 'synthetic read refusal' } : body) });
    if (state.holdA && (!filter || filter === 'eq.family-A')) {
      await new Promise<void>(resolve => { state.release.push(async () => { await reply(); resolve(); }); });
    } else await reply();
  });
  await page.goto(origin);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: sdk });
  await page.addScriptTag({ content: `(() => {
    const React = window.React, ReactDOM = window.ReactDOM, h = React.createElement;
    const sources = ${JSON.stringify(sources)}, modules = {};
    const rejections = [];
    window.addEventListener('unhandledrejection', event => { rejections.push(String(event.reason)); event.preventDefault(); });
    const app = { familyId: 'family-A', userId: 'user-one', userEmail: 'synthetic@example.invalid', role: ${JSON.stringify(options.role ?? 'parent')}, members: [{ id: 'member-family-A', display_name: 'Actor A' }, { id: 'member-family-B', display_name: 'Actor B' }] };
    const db = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-public-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    db.auth.getUser = async () => ({ data: { user: { id: app.userId, last_sign_in_at: null } }, error: null });
    db.auth.mfa.getAuthenticatorAssuranceLevel = async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });
    const noop = () => null;
    const requires = {
      react: React,
      'next/link': { default: ({ children, ...props }) => h('a', props, children) },
      'lucide-react': new Proxy({}, { get: () => noop }),
      '@/lib/supabase/client': { createClient: () => db },
      '@/components/app/app-context': { useApp: () => app },
      '@/components/i18n/locale-provider': { useTranslations: () => key => key },
      '@/components/i18n/use-format': { useFormat: () => ({ fmtDateTime: value => value }) },
      '@/components/ui/toast': { useToast: () => ({ success: noop, error: noop }) },
      '@/components/ui/button': { Button: ({ children, loading, size, variant, ...props }) => h('button', props, children) },
      '@/components/ui/card': { Card: ({ children, ...props }) => h('section', props, children) },
      '@/lib/auth/mfa': { sessionStrength: () => 'signed_in' },
      '@/components/auth/sign-out-form': { SignOutForm: () => null },
    };
    function load(file) {
      if (modules[file]) return modules[file];
      const module = { exports: {} };
      const require = name => {
        if (name === '@/lib/constants/roles') return load('lib/constants/roles.ts');
        if (name === '@/lib/supabase/settle') return load('lib/supabase/settle.ts');
        if (Object.hasOwn(requires, name)) return requires[name];
        throw new Error('Unexpected fixture import ' + name);
      };
      new Function('React', 'require', 'module', 'exports', sources[file])(React, require, module, module.exports);
      return modules[file] = module.exports;
    }
    const Component = load('components/settings/privacy-center.tsx').PrivacyCenter;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    window.__privacyFamily = {
      rejections,
      render: patch => { Object.assign(app, patch); ReactDOM.flushSync(() => root.render(h(Component))); return document.getElementById('root').textContent; },
      settle: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    };
    window.__privacyFamily.render({});
  })();` });
  return state;
}

test.afterEach(async ({ page }) => {
  const state = fixtureStates.get(page);
  if (!state) return;
  expect(state.errors, 'no uncaught browser exceptions').toEqual([]);
  expect(await page.evaluate(() => window.__privacyFamily?.rejections ?? []), 'no unhandled promise rejections').toEqual([]);
  expect(state.unexpected, 'no unexpected network requests').toEqual([]);
});

test('a manager sees only the active family in both access and export histories', async ({ page }) => {
  const state = await install(page);
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Actor B — family-B private history', { exact: true })).toHaveCount(0);
  expect(state.queries.map(url => url.searchParams.get('family_id'))).toEqual(['eq.family-A', 'eq.family-A']);
  expect(state.queries.map(url => url.searchParams.get('limit')).sort()).toEqual(['10', '50']);
  expect(state.unexpected).toEqual([]);
});

test('another managed family export does not erase the active family empty state', async ({ page }) => {
  const state = await install(page, { rows: [row('family-A'), row('family-B', true)] });
  await expect(page.getByText('privacyCenter.noExportsYet', { exact: true })).toBeVisible();
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

for (const role of ['teen', 'child', 'caregiver', 'guest', 'unknown']) {
  test(`${role} reads no audit history`, async ({ page }) => {
    const state = await install(page, { role });
    await expect(page.getByText('privacyCenter.managersOnly', { exact: true })).toHaveCount(2);
    await page.evaluate(() => window.__privacyFamily.settle());
    expect(state.queries).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  });
}

test('an adult receives the same active-family history boundary as a parent', async ({ page }) => {
  const state = await install(page, { role: 'adult' });
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Actor B — family-B private history', { exact: true })).toHaveCount(0);
  await expect(page.getByText('privacyCenter.managersOnly', { exact: true })).toHaveCount(0);
  expect(state.queries.map(url => url.searchParams.get('family_id'))).toEqual(['eq.family-A', 'eq.family-A']);
});

test('retained component refreshes history when the caller changes within the same family', async ({ page }) => {
  const state = await install(page, { rows: [row('family-A')] });
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toBeVisible();
  state.rows = [{ ...row('family-A'), id: 'new-caller-history', reason: 'New caller history' }];
  const immediate = await page.evaluate(() => window.__privacyFamily.render({ userId: 'user-two' }));
  expect(immediate).not.toContain('family-A private history');
  await expect(page.getByText('Actor A — New caller history', { exact: true })).toBeVisible();
  expect(state.queries.map(url => url.searchParams.get('family_id'))).toEqual(Array(4).fill('eq.family-A'));
});

test('retained component drops old family history before a same-role family change renders', async ({ page }) => {
  const state = await install(page, { rows: [row('family-A')] });
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toBeVisible();
  state.rows = [row('family-B')];
  const immediate = await page.evaluate(() => window.__privacyFamily.render({ familyId: 'family-B' }));
  expect(immediate).not.toContain('family-A private history');
  await expect(page.getByText('Actor B — family-B private history', { exact: true })).toBeVisible();
  expect(state.queries.map(url => url.searchParams.get('family_id'))).toEqual(['eq.family-A', 'eq.family-A', 'eq.family-B', 'eq.family-B']);
});

test('a held old-family read cannot replace the new family response', async ({ page }) => {
  const state = await install(page, { holdA: true });
  await expect.poll(() => state.release.length).toBe(2);
  await page.evaluate(() => window.__privacyFamily.render({ familyId: 'family-B' }));
  try {
    await expect(page.getByText('Actor B — family-B private history', { exact: true })).toHaveCount(2, { timeout: 2000 });
  } finally {
    await Promise.all(state.release.map(release => release()));
  }
  await page.evaluate(() => window.__privacyFamily.settle());
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Actor B — family-B private history', { exact: true })).toHaveCount(2);
});

test('a refused history stays retryable rather than appearing empty', async ({ page }) => {
  const state = await install(page, { fail: true });
  await expect(page.getByRole('alert')).toHaveCount(2);
  await expect(page.getByText('privacyCenter.noExportsYet', { exact: true })).toHaveCount(0);
  await expect(page.getByText('privacyCenter.noAccessYet', { exact: true })).toHaveCount(0);
  state.fail = false;
  await page.getByRole('button', { name: 'privacyCenter.retry', exact: true }).first().click();
  await expect(page.getByText('Actor A — family-A private history', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a genuine empty active history reports both empty states', async ({ page }) => {
  const state = await install(page, { rows: [] });
  await expect(page.getByText('privacyCenter.noExportsYet', { exact: true })).toBeVisible();
  await expect(page.getByText('privacyCenter.noAccessYet', { exact: true })).toBeVisible();
  expect(state.queries).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
});
