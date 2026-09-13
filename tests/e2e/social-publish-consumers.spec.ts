import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import type { CreatePostResult } from '@/app/(app)/dashboard/social/actions';
import type { ConnectorPublishOutput } from '@/lib/social/connectors';

// Real React Studio/retry/detail consumers, server actions, publish pipeline and
// installed Supabase/PostgREST execute against persisted in-memory HTTP rows.
// Auth/permissions and the external provider receipt are controlled boundaries.
// The scheduling receipt prepare/arm seam is controlled in this existing
// consumer suite; separate scheduling execution tests verify its private ledger.
// No database, OAuth credential or external publishing service is contacted.
type Row = Record<string, unknown> & { id: string };
const messages: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const clientFiles = ['components/social/studio-form.tsx', 'components/social/retry-button.tsx',
  'lib/social/capabilities.ts', 'lib/social/content.ts', 'lib/social/ai-kinds.ts', 'lib/social/schedule-time.ts',
  'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
  'components/social/platform.tsx', 'components/ui/card.tsx', 'components/ui/badge.tsx'];
const compile = (file: string) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;
const sources = Object.fromEntries(clientFiles.map(file => [`@/${file.replace(/\.tsx?$/, '')}`, compile(file)]));
const unknown: ConnectorPublishOutput = { ok: false, status: 'publishing', errorCode: 'confirmation_unknown', errorMessage: 'Provider confirmation is unavailable.' };
const confirmed: ConnectorPublishOutput = { ok: true, status: 'published', providerObjectId: 'external-post', permalinkUrl: 'https://x.com/fixture/status/1' };
const rejected: ConnectorPublishOutput = { ok: false, status: 'failed', errorCode: 'rejected', errorMessage: 'Provider rejected this post.' };
type Probe = { results: CreatePostResult[]; errors: string[]; capture: (name: string) => void; captured: () => void; mountRetry: (id: string) => void };
declare global { interface Window { __socialConsumer: Probe } }

async function fixture(page: Page, locale: 'en-US' | 'fr-FR' = 'en-US') {
  const catalogue: Record<string, string> = JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
  const rows: Record<string, Row[]> = Object.fromEntries(['social_posts', 'social_post_targets', 'social_post_variants',
    'social_publish_jobs', 'social_publish_results', 'social_usage_events', 'social_schedules', 'social_calendar_items', 'social_settings'].map(table => [table, []]));
  rows.social_accounts = [{ id: 'account-x', family_id: 'family', platform: 'x', provider_account_id: 'provider-account', deleted_at: null, status: 'connected' }];
  const state = { rows, requests: [] as Array<{ table: string; method: string }>, providerCalls: 0,
    receipt: unknown, failTable: '', loseResponse: false, holdProvider: false, release: () => {} };
  const sdk = createClient('https://social-consumer-fixture.supabase.co', 'non-secret-fixture', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init = {}) => {
      const url = new URL(String(input)), table = url.pathname.split('/').at(-1)!;
      const method = init.method ?? 'GET', headers = new Headers(init.headers), body = init.body ? JSON.parse(String(init.body)) : null;
      if (!rows[table]) throw new Error(`Unexpected fixture table: ${table}`);
      state.requests.push({ table, method });
      if (table === state.failTable && method === 'POST') return new Response(JSON.stringify({ code: '42501', message: 'Fixture write denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
      const matches = (row: Row) => [...url.searchParams].every(([key, value]) => {
        if (['select', 'order', 'limit', 'offset', 'columns'].includes(key)) return true;
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        if (value === 'is.null') return row[key] == null;
        if (value.startsWith('gt.')) return String(row[key]) > value.slice(3);
        if (value.startsWith('in.')) return value.slice(4, -1).split(',').includes(String(row[key]));
        if (value.startsWith('cs.')) return Object.entries(JSON.parse(value.slice(3))).every(([k, v]) => (row[key] as Record<string, unknown>)?.[k] === v);
        throw new Error(`Unexpected fixture filter: ${key} ${value}`);
      });
      let selected = rows[table].filter(matches);
      if (method === 'POST') {
        selected = (Array.isArray(body) ? body : [body]).map(item => ({ id: randomUUID(), metadata: {},
          deleted_at: null, approval_status: 'not_required', updated_at: new Date().toISOString(), attempted_at: new Date().toISOString(), published_at: null, permalink_url: null, error: null,
          ...item }));
        rows[table].push(...selected);
      } else if (method === 'PATCH') selected.forEach(row => Object.assign(row, body, { updated_at: new Date().toISOString() }));
      else if (method === 'DELETE') rows[table] = rows[table].filter(row => !selected.includes(row));
      if (url.searchParams.has('order')) selected.sort((a, b) => a.id.localeCompare(b.id));
      if (url.searchParams.has('limit')) selected = selected.slice(0, Number(url.searchParams.get('limit')));
      const object = headers.get('accept')?.includes('vnd.pgrst.object');
      return new Response(JSON.stringify(object ? (selected[0] ?? null) : selected), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  const serverMocks: Record<string, unknown> = {
    'server-only': {}, 'next/cache': { revalidatePath() {} }, 'next/headers': { cookies: async () => ({ set() {} }) },
    'next/link': { __esModule: true, default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props) },
    'next/navigation': { notFound() { throw new Error('Fixture post missing'); } },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/lib/i18n/server': { getTranslations: async () => (key: string) => catalogue[key] ?? key, getLocaleContext: async () => ({ locale: { code: locale } }) },
    '@/components/i18n/locale-provider': { useTranslations: () => (key: string) => catalogue[key] ?? key },
    '@/lib/supabase/auth': { requireUserContext: async () => ({ active: { familyId: 'family' }, user: { id: 'user' } }) },
    '@/lib/supabase/server': { createServer: async () => sdk },
    '@/lib/social/access': { requireSocialPermission: async () => {} },
    '@/lib/social/x-oauth': {}, '@/lib/social/account-tokens': {},
    '@/lib/social/scheduled-publish': {
      createScheduledPublishReceipt: async () => ({ receiptId: 'synthetic-schedule-receipt' }),
      armScheduledPublishReceipt: async () => ({ phase: 'queued' }),
      publishScheduledPostNow: async () => null,
      get ScheduledPublishError() { return (load('@/lib/social/scheduled-authority') as { ScheduledPublishError: typeof Error }).ScheduledPublishError; },
    },
    '@/lib/social/connectors': { getConnector: () => ({ publish: async () => {
      state.providerCalls += 1;
      if (state.holdProvider) await new Promise<void>(resolve => { state.release = () => { state.holdProvider = false; resolve(); }; });
      return state.receipt;
    } }) },
  };
  const modules: Record<string, unknown> = {};
  function load(id: string): unknown {
    if (id in serverMocks) return serverMocks[id];
    if (id in modules) return modules[id];
    const file = ['.ts', '.tsx'].map(ext => id.replace(/^@\//, '') + ext).find(file => fs.existsSync(file));
    if (!file) return require(id);
    const evaluated = { exports: {} }; modules[id] = evaluated.exports;
    new Function('require', 'module', 'exports', 'React', compile(file))((name: string) => load(name.startsWith('.') ? path.posix.normalize(`${path.posix.dirname(id)}/${name}`) : name), evaluated, evaluated.exports, React);
    return evaluated.exports;
  }
  const actions = load('@/app/(app)/dashboard/social/actions') as {
    createPostAction: (data: FormData) => Promise<CreatePostResult>;
    retryPublishAction: (id: string) => Promise<CreatePostResult>;
  };
  const detail = load('@/app/(app)/dashboard/social/posts/[id]/page') as { default: (props: { params: Promise<{ id: string }> }) => Promise<React.ReactElement> };
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }));
  await page.goto('https://social-consumer-fixture.invalid');
  await page.exposeFunction('createActualSocialPost', async (entries: Array<[string, string]>) => {
    const data = new FormData(); entries.forEach(([key, value]) => data.append(key, value));
    const result = await actions.createPostAction(data);
    if (state.loseResponse) throw new Error('Fixture transport lost the action response');
    return result;
  });
  await page.exposeFunction('retryActualSocialPost', actions.retryPublishAction);
  for (const pkg of ['react', 'react-dom']) await page.addScriptTag({ content: fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), `umd/${pkg}.development.js`), 'utf8') });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(catalogue)}, modules = {};
    const p = window.__socialConsumer = { results: [], errors: [] };
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const mocks = { react: React, 'next/navigation': { useRouter: () => ({ push: () => {} }) },
      'next/link': { __esModule: true, default: props => React.createElement('a', props) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/app/(app)/dashboard/social/actions': {
        createPostAction: async data => { const r = await window.createActualSocialPost([...data]); p.results.push(r); return r; },
        retryPublishAction: async id => { const r = await window.retryActualSocialPost(id); p.results.push(r); return r; },
      },
    };
    function load(id) {
      if (id in mocks) return mocks[id]; if (modules[id]) return modules[id];
      // LocaleProvider receives the actual selected catalogue below. Catalogue
      // imports are only the fallback data boundary; the context and translator
      // execute their production code with real localeOrDefault objects.
      if (id.startsWith('@/lib/i18n/messages/') && id.endsWith('.json')) return {};
      if (!sources[id]) throw new Error('Unexpected browser module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const Provider = load('@/components/i18n/locale-provider').LocaleProvider;
    const locale = load('@/lib/i18n/locales').localeOrDefault(${JSON.stringify(locale)});
    const withLocale = child => React.createElement(Provider, { locale, source: 'default', messages }, child);
    root.render(withLocale(React.createElement(load('@/components/social/studio-form').StudioForm, { accounts: [
      { id: 'account-x', platform: 'x', display_name: 'Fixture X', handle: 'fixture', status: 'connected' },
    ] })));
    p.mountRetry = postId => ReactDOM.flushSync(() => root.render(withLocale(React.createElement(load('@/components/social/retry-button').RetryPublishButton, { postId }))));
    p.capture = name => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === name);
      if (!button) throw new Error('Missing fixture button: ' + name);
      p.captured = button[Object.keys(button).find(key => key.startsWith('__reactProps$'))].onClick;
    };
  })();` });
  return { state, actions, detailHtml: async (id: string) => renderToStaticMarkup(await detail.default({ params: Promise.resolve({ id }) })) };
}

async function compose(page: Page) {
  await page.locator('textarea').fill('A single intended announcement');
  await page.getByRole('checkbox').check();
}
const publishButton = (page: Page) => page.getByRole('button', { name: messages['studio.publishNow'], exact: true });
async function resultCount(page: Page, count: number) { await expect.poll(() => page.evaluate(() => window.__socialConsumer.results.length)).toBe(count); }

test('an uncertain publish retains the existing post and refuses a second create through a retained handler', async ({ page }) => {
  const { state, actions, detailHtml } = await fixture(page); await compose(page);
  await page.evaluate(name => window.__socialConsumer.capture(name), messages['studio.publishNow']);
  await publishButton(page).click(); await resultCount(page, 1);
  expect(state.providerCalls).toBe(1); expect(state.rows.social_posts).toHaveLength(1);
  expect(state.rows.social_posts[0].status).toBe('publishing');
  await page.evaluate(() => window.__socialConsumer.captured());
  await expect.poll(() => state.providerCalls).toBe(1);
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.locator(`a[href="/dashboard/social/posts/${state.rows.social_posts[0].id}"]`)).toBeVisible();
  expect(state.rows.social_posts).toHaveLength(1);
  const requestIndex = state.requests.length;
  const retry = await actions.retryPublishAction(state.rows.social_posts[0].id);
  expect(retry.outcome).toMatchObject({ status: 'publishing', jobId: null });
  expect(state.providerCalls).toBe(1);
  expect(state.requests.slice(requestIndex).every(request => request.method === 'GET')).toBe(true);
  state.rows.social_post_targets.push({ ...state.rows.social_post_targets[0], id: 'second-target', status: 'failed' });
  await page.setContent(await detailHtml(state.rows.social_posts[0].id));
  await expect(page.getByRole('button', { name: messages['retryButton.retryPublish'], exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(messages['socialPost.awaitingConfirmation']);
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__socialConsumer.errors)).toEqual([]);
});

for (const [name, receipt] of [['confirmed', confirmed], ['rejected', rejected]] as const) {
  test(`${name} publication keeps the persisted identity and cannot create another copy`, async ({ page }) => {
    const { state, detailHtml } = await fixture(page); state.receipt = receipt; await compose(page);
    await page.evaluate(name => window.__socialConsumer.capture(name), messages['studio.publishNow']);
    await publishButton(page).click(); await resultCount(page, 1);
    await page.evaluate(() => window.__socialConsumer.captured());
    expect(state.providerCalls).toBe(1); expect(state.rows.social_posts).toHaveLength(1);
    await expect(publishButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: messages['studio.saveDraft'], exact: true })).toBeDisabled();
    const post = state.rows.social_posts[0];
    await expect(page.locator(`a[href="/dashboard/social/posts/${post.id}"]`)).toBeVisible();
    await page.setContent(await detailHtml(post.id));
    await expect(page.getByRole('button', { name: messages['retryButton.retryPublish'], exact: true })).toHaveCount(receipt.status === 'failed' ? 1 : 0);
    if (receipt.status === 'published') await expect(page.locator(`a[href="${receipt.permalinkUrl}"]`)).toBeVisible();
  });
}

test('two synchronous submits and a click while the provider is held create only one post', async ({ page }) => {
  const { state } = await fixture(page); state.holdProvider = true; await compose(page);
  await page.evaluate(name => window.__socialConsumer.capture(name), messages['studio.publishNow']);
  await page.evaluate(() => { window.__socialConsumer.captured(); window.__socialConsumer.captured(); });
  await expect.poll(() => state.providerCalls).toBe(1);
  await expect(publishButton(page)).toBeDisabled();
  await page.evaluate(() => window.__socialConsumer.captured());
  expect(state.rows.social_posts).toHaveLength(1);
  state.release(); await resultCount(page, 1);
  expect(state.providerCalls).toBe(1); expect(state.rows.social_publish_results).toHaveLength(1);
  await expect(publishButton(page)).toBeDisabled();
});

test('provider acceptance followed by result persistence failure returns the retained post for review', async ({ page }) => {
  const { state } = await fixture(page); state.receipt = confirmed; state.failTable = 'social_publish_results'; await compose(page);
  await publishButton(page).click(); await resultCount(page, 1);
  expect(state.providerCalls).toBe(1); expect(state.rows.social_posts).toHaveLength(1);
  const post = state.rows.social_posts[0];
  expect(post.status).toBe('publishing'); expect(state.rows.social_post_targets[0].status).toBe('publishing');
  expect(await page.evaluate(() => window.__socialConsumer.results[0])).toMatchObject({ ok: false, action: 'publish', postId: post.id });
  await expect(page.locator(`a[href="/dashboard/social/posts/${post.id}"]`)).toBeVisible();
  await expect(publishButton(page)).toBeDisabled();
  expect(state.requests.filter(request => request.method === 'DELETE')).toEqual([]);
});

test('a true pre-publish target failure preserves the draft and permits a successful retry', async ({ page }) => {
  const { state } = await fixture(page); state.failTable = 'social_post_targets'; await compose(page);
  await publishButton(page).click(); await resultCount(page, 1);
  expect(state.providerCalls).toBe(0); expect(state.rows.social_posts).toHaveLength(0);
  expect(await page.evaluate(() => window.__socialConsumer.results[0].postId)).toBeUndefined();
  await expect(page.locator('textarea')).toHaveValue('A single intended announcement');
  await expect(page.getByRole('checkbox')).toBeChecked(); await expect(publishButton(page)).toBeEnabled();
  state.failTable = ''; state.receipt = confirmed;
  await publishButton(page).click(); await resultCount(page, 2);
  expect(state.rows.social_posts).toHaveLength(1); expect(state.providerCalls).toBe(1);
  expect(state.rows.social_posts[0]).toMatchObject({ body: 'A single intended announcement', status: 'published' });
  await expect(publishButton(page)).toBeDisabled();
});

test('a lost action response does not offer a duplicate create after the provider has accepted', async ({ page }) => {
  const { state } = await fixture(page); state.receipt = confirmed; state.loseResponse = true; await compose(page);
  await page.evaluate(name => window.__socialConsumer.capture(name), messages['studio.publishNow']);
  await publishButton(page).click();
  await expect(page.getByRole('alert')).toContainText(messages['socialStudio.requestUnconfirmed']);
  expect(state.providerCalls).toBe(1); expect(state.rows.social_posts[0].status).toBe('published');
  await expect(page.locator('a[href="/dashboard/social/posts"]')).toBeVisible();
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.locator('textarea')).toHaveValue('A single intended announcement');
  await page.evaluate(() => window.__socialConsumer.captured());
  expect(state.providerCalls).toBe(1); expect(state.rows.social_posts).toHaveLength(1);
});

test('a saved schedule links to its existing record and does not schedule or publish a second copy', async ({ page }) => {
  const { state } = await fixture(page); await compose(page);
  await page.locator('input[type="datetime-local"]').fill('2026-10-01T12:00');
  await page.getByRole('button', { name: messages['studio.schedule'], exact: true }).click(); await resultCount(page, 1);
  expect(state.rows.social_posts).toHaveLength(1); expect(state.rows.social_schedules).toHaveLength(1); expect(state.rows.social_calendar_items).toHaveLength(1);
  expect(state.providerCalls).toBe(0);
  await expect(page.locator(`a[href="/dashboard/social/posts/${state.rows.social_posts[0].id}"]`)).toBeVisible();
  await expect(publishButton(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: messages['studio.schedule'], exact: true })).toBeDisabled();
});

test('retry consumer reports an existing uncertain attempt as awaiting confirmation without resending', async ({ page }) => {
  const { state } = await fixture(page); await compose(page);
  await publishButton(page).click(); await resultCount(page, 1);
  await page.evaluate(id => window.__socialConsumer.mountRetry(id), state.rows.social_posts[0].id);
  await page.getByRole('button', { name: messages['retryButton.retryPublish'], exact: true }).click(); await resultCount(page, 2);
  await expect(page.getByText(messages['socialPost.awaitingConfirmation'], { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: messages['retryButton.retryPublish'], exact: true })).toBeDisabled();
  await expect(page.getByText('Retried — see results below.', { exact: true })).toHaveCount(0);
  expect(state.providerCalls).toBe(1); expect(state.rows.social_publish_results).toHaveLength(1);
});

test('a legitimate failed-target retry uses the same post and preserves earlier history', async ({ page }) => {
  const { state } = await fixture(page); state.receipt = rejected; await compose(page);
  await publishButton(page).click(); await resultCount(page, 1);
  const postId = state.rows.social_posts[0].id; state.receipt = confirmed; state.holdProvider = true;
  await page.evaluate(id => window.__socialConsumer.mountRetry(id), postId);
  await page.evaluate(name => window.__socialConsumer.capture(name), messages['retryButton.retryPublish']);
  await page.evaluate(() => { window.__socialConsumer.captured(); window.__socialConsumer.captured(); });
  await expect.poll(() => state.providerCalls).toBe(2);
  await expect(page.getByRole('button', { name: messages['retryButton.retryPublish'], exact: true })).toBeDisabled();
  state.release(); await resultCount(page, 2);
  await expect(page.getByText(messages['socialPost.retryAttempted'], { exact: true })).toBeVisible();
  expect(state.rows.social_posts).toHaveLength(1); expect(state.rows.social_posts[0]).toMatchObject({ id: postId, status: 'published' });
  expect(state.rows.social_publish_results.map(row => row.status)).toEqual(['failed', 'published']);
});

test('history never labels an unconfirmed or failed result confirmed merely because it has no URL', async ({ page }) => {
  const { state, detailHtml } = await fixture(page); await compose(page);
  await publishButton(page).click(); await resultCount(page, 1);
  state.rows.social_publish_results[0].error_code = null; state.rows.social_publish_results[0].error_message = null;
  state.rows.social_publish_results.push({ ...state.rows.social_publish_results[0], id: 'failed-history', status: 'failed' });
  await page.setContent(await detailHtml(state.rows.social_posts[0].id));
  await expect(page.getByText('confirmed', { exact: true })).toHaveCount(0);
  await expect(page.getByText(messages['socialPost.awaitingConfirmation'], { exact: true })).toHaveCount(2);
});

test('actual French LocaleProvider renders the persisted-post review and uncertainty copy', async ({ page }) => {
  const french: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  const { state } = await fixture(page, 'fr-FR'); await compose(page);
  await page.getByRole('button', { name: french['studio.publishNow'], exact: true }).click(); await resultCount(page, 1);
  await expect(page.getByText(french['socialStudio.reviewRequired'], { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: french['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${state.rows.social_posts[0].id}`);
  await page.evaluate(id => window.__socialConsumer.mountRetry(id), state.rows.social_posts[0].id);
  await page.getByRole('button', { name: french['retryButton.retryPublish'], exact: true }).click(); await resultCount(page, 2);
  await expect(page.getByText(french['socialPost.awaitingConfirmation'], { exact: true })).toBeVisible();
  await expect(page.getByText(messages['socialPost.awaitingConfirmation'], { exact: true })).toHaveCount(0);
  expect(state.providerCalls).toBe(1);
});
