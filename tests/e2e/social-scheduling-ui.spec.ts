import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import type { CreatePostResult } from '@/app/(app)/dashboard/social/actions';

// Actual StudioForm, schedule-time conversion, shared presentation components
// and LocaleProvider execute in Chromium. createPostAction is an explicit
// controlled server boundary: these are consumer/contract checks, not SDK,
// durable worker, provider delivery or complete Next-navigation assertions.
const origin = 'https://social-scheduling-ui-fixture.invalid';
const en: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const clientFiles = [
  'components/social/studio-form.tsx', 'lib/social/schedule-time.ts',
  'lib/social/capabilities.ts', 'lib/social/content.ts', 'lib/social/ai-kinds.ts',
  'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts', 'lib/i18n/messages.ts',
  'components/social/platform.tsx', 'components/ui/card.tsx', 'components/ui/badge.tsx',
];
const sources = Object.fromEntries(clientFiles.map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText]));
const queued: CreatePostResult = { ok: true, action: 'schedule', postId: '20000000-0000-4000-8000-000000000001', schedulePhase: 'queued' };
type Submission = Array<[string, string]>;
type Fixture = { calls: Submission[]; result: CreatePostResult; hold: boolean; loseResponse: boolean; release: () => void };
type Probe = { errors: string[]; results: CreatePostResult[]; navigations: string[]; capture: (name: string) => void; captured: () => Promise<void>; captureChange: (selector: string) => void; changed: (value: string) => void; refreshAccounts: (status: string) => void; unmount: () => void; settle: () => Promise<void> };
declare global { interface Window { __socialSchedulingUI: Probe } }

test.use({ timezoneId: 'Asia/Tokyo' });

async function fixture(page: Page, options: { defaultTimezone?: string; locale?: 'en-US' | 'fr-FR' } = {}): Promise<Fixture> {
  const localeCode = options.locale ?? 'en-US';
  const catalogue: Record<string, string> = JSON.parse(fs.readFileSync(`lib/i18n/messages/${localeCode}.json`, 'utf8'));
  const state: Fixture = { calls: [], result: queued, hold: false, loseResponse: false, release: () => {} };
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) throw new Error(`Unexpected fixture request ${route.request().url()}`);
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
  });
  await page.exposeFunction('submitSocialSchedule', async (entries: Submission) => {
    state.calls.push(entries);
    if (state.hold) await new Promise<void>(resolve => { state.release = () => { state.hold = false; resolve(); }; });
    if (state.loseResponse) throw new Error('Fixture lost action response');
    return state.result;
  });
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:00.000Z'));
  await page.goto(origin);
  for (const pkg of ['react', 'react-dom']) await page.addScriptTag({ content: fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), `umd/${pkg}.development.js`), 'utf8') });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(catalogue)}, modules = {};
    const p = window.__socialSchedulingUI = { errors: [], results: [], navigations: [] };
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => { p.errors.push(String(e.reason)); e.preventDefault(); });
    const mocks = { react: React,
      'next/navigation': { useRouter: () => ({ push: href => p.navigations.push(href) }) },
      'next/link': { __esModule: true, default: props => React.createElement('a', props) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/app/(app)/dashboard/social/actions': { createPostAction: async data => {
        const result = await window.submitSocialSchedule([...data]); p.results.push(result); return result;
      } },
    };
    function load(id) {
      if (id in mocks) return mocks[id]; if (modules[id]) return modules[id];
      if (id.startsWith('@/lib/i18n/messages/') && id.endsWith('.json')) return {};
      if (!sources[id]) throw new Error('Unexpected browser module: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(name => load(name.startsWith('./') ? id.slice(0, id.lastIndexOf('/') + 1) + name.slice(2) : name), module, module.exports);
      return module.exports;
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const Provider = load('@/components/i18n/locale-provider').LocaleProvider;
    const locale = load('@/lib/i18n/locales').localeOrDefault(${JSON.stringify(localeCode)});
    let accounts = [{ id: 'account-x', platform: 'x', display_name: 'Fixture X', handle: 'fixture', status: 'connected' }];
    function render() { ReactDOM.flushSync(() => root.render(React.createElement(Provider, { locale, source: 'default', messages },
      React.createElement(load('@/components/social/studio-form').StudioForm, { ...${JSON.stringify(options)}, accounts })))); }
    render();
    p.refreshAccounts = status => { accounts = accounts.map(account => ({ ...account, status })); render(); };
    p.captureChange = selector => {
      const input = document.querySelector(selector);
      const change = input[Object.keys(input).find(key => key.startsWith('__reactProps$'))].onChange;
      p.changed = value => change({ target: { value } });
    };
    p.capture = name => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === name);
      if (!button) throw new Error('Missing fixture button: ' + name);
      p.captured = button[Object.keys(button).find(key => key.startsWith('__reactProps$'))].onClick;
    };
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();` });
  await page.locator('textarea').fill('One scheduled announcement');
  await page.getByRole('checkbox').check();
  return state;
}

const fields = (state: Fixture, index = 0) => Object.fromEntries(state.calls[index]);
const scheduleButton = (page: Page) => page.getByRole('button', { name: en['studio.schedule'], exact: true });
async function schedule(page: Page, local = '2026-07-01T09:00', zone = 'America/New_York') {
  await page.getByLabel(en['studio.scheduleFor'], { exact: true }).fill(local);
  await page.getByLabel(en['socialSchedule.timezone'], { exact: true }).fill(zone);
}
async function result(page: Page) { await expect.poll(() => page.evaluate(() => window.__socialSchedulingUI.results.length)).toBe(1); }
async function settled(page: Page) { await page.evaluate(() => window.__socialSchedulingUI.settle()); }

test.afterEach(async ({ page }) => { expect(await page.evaluate(() => window.__socialSchedulingUI.errors)).toEqual([]); });

test('New York 09:00 reaches the action as 13:00Z with the original local time and explicit IANA zone', async ({ page }) => {
  const state = await fixture(page); await schedule(page);
  await expect(page.getByRole('status')).toHaveText(en['socialSchedule.instant'].replace('{instant}', '2026-07-01T13:00:00.000Z'));
  await scheduleButton(page).click(); await result(page);
  expect(fields(state)).toMatchObject({ intent: 'schedule', scheduled_for: '2026-07-01T13:00:00.000Z', scheduled_local: '2026-07-01T09:00', timezone: 'America/New_York', body: 'One scheduled announcement', account_ids: 'account-x' });
  expect(state.calls).toHaveLength(1);
});

for (const [name, local, zone, key] of [
  ['DST gap', '2026-03-08T02:30', 'America/New_York', 'socialSchedule.clockChange'],
  ['DST repeated wall time', '2026-11-01T01:30', 'America/New_York', 'socialSchedule.clockChange'],
  ['past date', '2025-12-31T09:00', 'America/New_York', 'socialSchedule.pastTime'],
  ['invalid zone', '2026-07-01T09:00', 'Not/A_Timezone', 'socialSchedule.invalidZone'],
] as const) {
  test(`${name} displays a localized error and dispatches no action, including retained submit`, async ({ page }) => {
    const state = await fixture(page); await schedule(page, local, zone);
    await expect(page.getByRole('alert')).toHaveText(en[key]);
    await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
    await scheduleButton(page).click(); await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page);
    expect(state.calls).toEqual([]); await expect(page.locator('textarea')).toHaveValue('One scheduled announcement');
    await schedule(page); await scheduleButton(page).click(); await result(page); expect(state.calls).toHaveLength(1);
  });
}

test('an empty local datetime is rejected in the handler even when the disabled button is bypassed', async ({ page }) => {
  const state = await fixture(page); await expect(scheduleButton(page)).toBeDisabled();
  await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
  await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page);
  expect(state.calls).toEqual([]); await expect(page.getByText(en['socialSchedule.invalidTime'], { exact: true })).toBeVisible();
});

test('submit rechecks current time after the displayed future schedule expires', async ({ page }) => {
  const state = await fixture(page, { defaultTimezone: 'UTC' }); await schedule(page, '2026-01-01T12:01', 'UTC');
  await expect(page.getByRole('status')).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-01-01T12:02:00.000Z')); await scheduleButton(page).click(); await settled(page);
  expect(state.calls).toEqual([]); await expect(page.getByText(en['socialSchedule.pastTime'], { exact: true })).toBeVisible();
});

test('an explicit saved default zone overrides the browser zone and survives entry edits', async ({ page }) => {
  const state = await fixture(page, { defaultTimezone: 'Europe/Paris' });
  await expect(page.getByLabel(en['socialSchedule.timezone'], { exact: true })).toHaveValue('Europe/Paris');
  await page.getByLabel(en['studio.scheduleFor'], { exact: true }).fill('2026-07-01T09:00');
  await page.locator('textarea').fill('Paris announcement'); await scheduleButton(page).click(); await result(page);
  expect(fields(state)).toMatchObject({ scheduled_for: '2026-07-01T07:00:00.000Z', scheduled_local: '2026-07-01T09:00', timezone: 'Europe/Paris' });
});

test('without a saved default, the actual browser timezone is displayed and used explicitly', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.getByLabel(en['socialSchedule.timezone'], { exact: true })).toHaveValue('Asia/Tokyo');
  await page.getByLabel(en['studio.scheduleFor'], { exact: true }).fill('2026-07-01T09:00'); await scheduleButton(page).click(); await result(page);
  expect(fields(state)).toMatchObject({ timezone: 'Asia/Tokyo', scheduled_for: '2026-07-01T00:00:00.000Z' });
});

for (const phase of ['queued', 'approval_required'] as const) {
  test(`${phase} result uses its own status copy and links the existing post without creating again`, async ({ page }) => {
    const state = await fixture(page); state.result = { ...queued, schedulePhase: phase }; await schedule(page);
    await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']); await scheduleButton(page).click(); await result(page);
    const key = phase === 'queued' ? 'socialSchedule.queued' : 'socialSchedule.approvalRequired';
    await expect(page.getByText(en[key], { exact: true })).toBeVisible();
    await expect(page.getByText(en[phase === 'queued' ? 'socialSchedule.approvalRequired' : 'socialSchedule.queued'], { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: en['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${queued.postId}`);
    await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page); expect(state.calls).toHaveLength(1);
    await expect(scheduleButton(page)).toBeDisabled(); await expect(page.getByRole('button', { name: en['studio.publishNow'], exact: true })).toBeDisabled();
  });
}

test('same-turn schedule callbacks dispatch once while the action is held and remain locked afterward', async ({ page }) => {
  const state = await fixture(page); state.hold = true; await schedule(page);
  await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
  await page.evaluate(() => { void window.__socialSchedulingUI.captured(); void window.__socialSchedulingUI.captured(); });
  await expect.poll(() => state.calls.length).toBe(1); await expect(scheduleButton(page)).toBeDisabled();
  await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page); expect(state.calls).toHaveLength(1);
  state.release(); await result(page); await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page); expect(state.calls).toHaveLength(1);
});

test('lost schedule action response preserves input and requires review without another create', async ({ page }) => {
  const state = await fixture(page); state.loseResponse = true; await schedule(page);
  await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']); await scheduleButton(page).click();
  await expect(page.getByRole('alert')).toHaveText(en['socialStudio.requestUnconfirmed']);
  await expect(page.getByRole('link', { name: en['socialStudio.reviewPosts'], exact: true })).toHaveAttribute('href', '/dashboard/social/posts');
  await expect(page.locator('textarea')).toHaveValue('One scheduled announcement');
  await expect(page.getByLabel(en['studio.scheduleFor'], { exact: true })).toHaveValue('2026-07-01T09:00');
  await expect(scheduleButton(page)).toBeDisabled(); await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page); expect(state.calls).toHaveLength(1);
});

test('a definitive action rejection preserves the schedule and allows an explicit corrected retry', async ({ page }) => {
  const state = await fixture(page); state.result = { ok: false, error: 'Fixture permission rejected' }; await schedule(page);
  await scheduleButton(page).click(); await result(page); await expect(page.getByText('Fixture permission rejected', { exact: true })).toBeVisible();
  await expect(scheduleButton(page)).toBeEnabled(); await expect(page.getByLabel(en['studio.scheduleFor'], { exact: true })).toHaveValue('2026-07-01T09:00');
  state.result = queued; await scheduleButton(page).click(); await expect.poll(() => state.calls.length).toBe(2);
  await expect(page.getByText(en['socialSchedule.queued'], { exact: true })).toBeVisible();
});

test('Publish now stays an immediate intent even when a future schedule is entered', async ({ page }) => {
  const state = await fixture(page); state.result = { ok: true, action: 'publish', postId: queued.postId }; await schedule(page);
  await expect(page.getByRole('button', { name: en['studio.publishNow'], exact: true })).toBeVisible();
  await page.getByRole('button', { name: en['studio.publishNow'], exact: true }).click(); await result(page);
  expect(fields(state)).toMatchObject({ intent: 'publish', scheduled_for: '', scheduled_local: '', timezone: 'America/New_York' });
  await expect(page.getByText(en['socialSchedule.queued'], { exact: true })).toHaveCount(0);
});

test('real French provider renders approval-held scheduling and clock-change recovery copy', async ({ page }) => {
  const fr: Record<string, string> = JSON.parse(fs.readFileSync('lib/i18n/messages/fr-FR.json', 'utf8'));
  const state = await fixture(page, { defaultTimezone: 'America/New_York', locale: 'fr-FR' });
  await page.getByLabel(fr['studio.scheduleFor'], { exact: true }).fill('2026-11-01T01:30');
  await expect(page.getByRole('alert')).toHaveText(fr['socialSchedule.clockChange']);
  await page.getByRole('button', { name: fr['studio.schedule'], exact: true }).click(); await settled(page); expect(state.calls).toEqual([]);
  state.result = { ...queued, schedulePhase: 'approval_required' };
  await page.getByLabel(fr['studio.scheduleFor'], { exact: true }).fill('2026-07-01T09:00');
  await page.getByRole('button', { name: fr['studio.schedule'], exact: true }).click(); await result(page);
  await expect(page.getByText(fr['socialSchedule.approvalRequired'], { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: fr['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${queued.postId}`);
});


test('a retained schedule callback cannot submit the previous time after the draft changes', async ({ page }) => {
  const state = await fixture(page); await schedule(page);
  await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
  await page.getByLabel(en['studio.scheduleFor'], { exact: true }).fill('2026-07-01T17:00');
  await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page);
  expect(state.calls).toEqual([]);
  await scheduleButton(page).click(); await result(page);
  expect(fields(state)).toMatchObject({ scheduled_local: '2026-07-01T17:00', scheduled_for: '2026-07-01T21:00:00.000Z' });
});

test('an unmounted Studio cannot dispatch a retained schedule callback', async ({ page }) => {
  const state = await fixture(page); await schedule(page);
  await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
  await page.evaluate(() => window.__socialSchedulingUI.unmount());
  await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page);
  expect(state.calls).toEqual([]);
});


test('a draft response received after unmount cannot navigate the replacement screen', async ({ page }) => {
  const state = await fixture(page); state.hold = true; state.result = { ok: true, action: 'draft', postId: queued.postId };
  await page.getByRole('button', { name: en['studio.saveDraft'], exact: true }).click(); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => window.__socialSchedulingUI.unmount()); state.release(); await result(page); await settled(page);
  expect(await page.evaluate(() => window.__socialSchedulingUI.navigations)).toEqual([]);
});


test('pending fieldset and retained edit callbacks keep the dispatched draft stable', async ({ page }) => {
  const state = await fixture(page); state.hold = true; await schedule(page);
  await page.evaluate(() => window.__socialSchedulingUI.captureChange('textarea'));
  await scheduleButton(page).click(); await expect.poll(() => state.calls.length).toBe(1);
  await expect(page.locator('textarea')).toBeDisabled(); await expect(page.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByLabel(en['studio.scheduleFor'], { exact: true })).toBeDisabled(); await expect(page.getByLabel(en['socialSchedule.timezone'], { exact: true })).toBeDisabled();
  await page.evaluate(() => window.__socialSchedulingUI.changed('Retained callback replacement')); await settled(page);
  state.release(); await result(page); await settled(page);
  await expect(page.locator('textarea')).toHaveValue('One scheduled announcement');
  await expect(page.getByRole('link', { name: en['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${queued.postId}`);
});

test('account props refreshed during dispatch lead to review rather than a permanently pending editor', async ({ page }) => {
  const state = await fixture(page); state.hold = true; await schedule(page);
  await scheduleButton(page).click(); await expect.poll(() => state.calls.length).toBe(1);
  await page.evaluate(() => window.__socialSchedulingUI.refreshAccounts('needs_reconnect')); state.release(); await result(page); await settled(page);
  await expect(page.getByRole('link', { name: en['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${queued.postId}`);
  await expect(page.getByRole('alert')).toHaveText(en['socialStudio.requestUnconfirmed']);
  await expect(scheduleButton(page)).toBeDisabled(); expect(state.calls).toHaveLength(1);
});


for (const knownId of [false, true]) {
  test(`typed ambiguous action result ${knownId ? 'with' : 'without'} a post ID locks the draft for review`, async ({ page }) => {
    const state = await fixture(page); state.result = { ok: false, error: 'Fixture insert acknowledgement unavailable', reviewRequired: true,
      ...(knownId ? { postId: queued.postId } : {}) }; await schedule(page);
    await page.evaluate(label => window.__socialSchedulingUI.capture(label), en['studio.schedule']);
    await scheduleButton(page).click(); await result(page);
    await expect(page.getByRole('alert')).toHaveText(en['socialStudio.requestUnconfirmed']);
    await expect(page.getByRole('link', { name: en['socialStudio.reviewPosts'], exact: true })).toHaveAttribute('href', '/dashboard/social/posts');
    if (knownId) await expect(page.getByRole('link', { name: en['socialStudio.reviewPost'], exact: true })).toHaveAttribute('href', `/dashboard/social/posts/${queued.postId}`);
    else await expect(page.getByRole('link', { name: en['socialStudio.reviewPost'], exact: true })).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveValue('One scheduled announcement'); await expect(page.locator('textarea')).toBeDisabled();
    await expect(scheduleButton(page)).toBeDisabled(); await page.evaluate(() => window.__socialSchedulingUI.captured()); await settled(page); expect(state.calls).toHaveLength(1);
  });
}
