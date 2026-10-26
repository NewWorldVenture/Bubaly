import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Real React, DOM, lifecycle, BroadcastChannel and storage events. Only the
// server actions are controlled: their own authorization/CAS tests live in
// app-lock-is-enforced-on-the-server and app-lock-adversarial. This exercises
// retirement of previously delivered data; the Next RSC fixture covers data
// that must never be delivered to a locked request in the first place.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries([
  'components/app/app-lock-boundary.tsx', 'components/app/app-lock-gate.tsx',
  'components/settings/app-lock-settings.tsx', 'components/ui/modal.tsx', 'components/ui/button.tsx',
  'components/ui/confirm.tsx', 'components/ui/toast.tsx', 'lib/hooks/use-media-query.ts',
  'lib/security/app-lock-browser.ts', 'lib/security/app-lock.ts', 'lib/offline/cache.ts',
  'lib/hooks/use-lock-body-scroll.ts', 'lib/a11y/use-dialog-behavior.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const PRIVATE = 'PRIVATE-FAMILY-DOCUMENT-7491';
const ORIGIN = 'https://app-lock-fixture.invalid/';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

type Probe = {
  lockCalls: boolean[]; unlockCalls: string[]; saveCalls: unknown[]; errors: string[]; unmounts: number;
  status: { ok: true; enabled: boolean; hasPin: boolean } | { ok: false; error: string };
  saveOutcome: unknown; pendingSave: boolean;
  statusReject: boolean;
  render: (locked?: boolean, enabled?: boolean, secret?: string) => void;
  lock: () => void; changed: () => void; retire: () => void;
  releaseLock: (index: number, ok: boolean) => void;
  releaseUnlock: (index: number, result: unknown) => void;
  releaseSave: (result: unknown) => void;
  seed: () => void; cache: () => string[]; settle: () => Promise<void>;
  peek: () => unknown;
  showNotices: () => void;
};
declare global { interface Window { __appLock: Probe } }

async function fixture(page: Page, options: { locked?: boolean; settings?: boolean; enabled?: boolean; hasPin?: boolean; notifications?: boolean } = {}) {
  await page.route(`${ORIGIN}**`, route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><main id="root">FRESH-SERVER-DOCUMENT</main></body></html>' }));
  await page.goto(options.locked ? `${ORIGIN}app-lock?next=%2Fdashboard` : ORIGIN);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, modules = {};
    const secret = ${JSON.stringify(PRIVATE)}, options = ${JSON.stringify(options)};
    const p = window.__appLock = { lockCalls: [], unlockCalls: [], saveCalls: [], errors: [], unmounts: 0,
      status: { ok: true, enabled: options.enabled ?? true, hasPin: options.hasPin ?? true },
      saveOutcome: { ok: true }, pendingSave: false, statusReject: false };
    const lockResolvers = [], unlockResolvers = [];
    let saveResolver, root;
    const tr = key => messages[key] ?? key;
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const mocks = {
      react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/components/i18n/locale-provider': { useTranslations: () => tr, usePlural: () => tr },
      '@/components/app/app-context': { useApp: () => ({ userId: 'user-a' }) },
      '@/components/ui/toast': { useToast: () => ({ success() {}, error() {} }) },
      '@/lib/supabase/errors': { localizeDbErrorText: value => value },
      '@/components/auth/sign-out-form': { SignOutForm: ({ children, ...props }) => React.createElement('form',
        { ...props, action: '/auth/signout' }, children({ signingOut: false })) },
      '@/app/(app)/settings/app-lock-actions': {
        getAppLockSettings: async () => { if (p.statusReject) throw new Error('Offline'); return p.status; },
        lockAppAction: () => {
          p.lockCalls.push(document.body.textContent.includes(secret));
          return new Promise(resolve => lockResolvers.push(resolve));
        },
        unlockAppAction: pin => { p.unlockCalls.push(pin); return new Promise(resolve => unlockResolvers.push(resolve)); },
        saveAppLockConfig: value => {
          p.saveCalls.push(value);
          if (p.pendingSave) return new Promise(resolve => { saveResolver = resolve; });
          return Promise.resolve(p.saveOutcome);
        },
      },
    };
    if (options.notifications) delete mocks['@/components/ui/toast'];
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const { AppLockBoundary } = load('@/components/app/app-lock-boundary');
    const { AppLockSettings } = load('@/components/settings/app-lock-settings');
    const browser = load('@/lib/security/app-lock-browser'), cache = load('@/lib/offline/cache');
    function PrivateContent({ value }) {
      React.useEffect(() => () => { p.unmounts++; }, []);
      if (options.notifications) {
        const toast = load('@/components/ui/toast').useToast();
        const confirm = load('@/components/ui/confirm').useConfirm();
        p.showNotices = () => {
          toast.success('PRIVATE-TOAST-MEDICAL-NAME');
          void confirm({ title: 'PRIVATE-CONFIRM-DOCUMENT-NAME', body: 'PRIVATE-CONFIRM-DETAILS' });
        };
      }
      return React.createElement('section', { 'data-private': true }, value,
        options.settings ? React.createElement(AppLockSettings) : null);
    }
    p.render = (locked = options.locked ?? false, enabled = options.enabled ?? true, value = secret) => {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      let content = locked ? null : React.createElement(PrivateContent, { value });
      if (!locked && options.notifications) content = React.createElement(load('@/components/ui/toast').ToastProvider,
        null, React.createElement(load('@/components/ui/confirm').ConfirmProvider, null, content));
      ReactDOM.flushSync(() => root.render(React.createElement(AppLockBoundary,
        { userId: 'user-a', enabled, locked, ...(options.locked ? { returnTo: '/dashboard' } : {}) }, content)));
    };
    p.lock = () => { void browser.requestAppLock('user-a'); };
    p.changed = () => browser.notifyAppLockSettingsChanged('user-a');
    p.peek = () => browser.readAppLockIntent('user-a');
    p.retire = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.releaseLock = (index, ok) => lockResolvers[index]({ ok, ...(ok ? {} : { error: 'Unavailable' }) });
    p.releaseUnlock = (index, result) => unlockResolvers[index](result);
    p.releaseSave = result => saveResolver(result);
    p.seed = () => cache.writeCache('bub:cache:family:documents', [{ private: secret }]);
    p.cache = () => Object.keys(localStorage).filter(key => key.startsWith('bub:cache:'));
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    p.render();
  })();` });
  await page.evaluate(() => window.__appLock.settle());
}

test('Lock now unmounts sensitive DOM and purges query cache before the server request, including on failure', async ({ page }) => {
  await fixture(page, { settings: true });
  await page.evaluate(() => window.__appLock.seed());
  await page.getByRole('button', { name: 'Lock now', exact: true }).click();
  await expect(page.locator('[data-private]')).toHaveCount(0);
  expect(await page.evaluate(() => ({ beforeRequest: window.__appLock.lockCalls, unmounts: window.__appLock.unmounts, cache: window.__appLock.cache() })))
    .toEqual({ beforeRequest: [false], unmounts: 1, cache: [] });
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__appLock.releaseLock(0, false));
  await expect(page.getByRole('alert')).toContainText('staying locked');
  await expect(page.locator('[data-private]')).toHaveCount(0);
  // Failed requests have an actual retry and a sign-out escape.
  await page.getByRole('button', { name: 'Lock now', exact: true }).click();
  await expect(page).toHaveURL(/\/app-lock\?next=/);
  await fixture(page, { locked: true });
  await page.getByRole('button', { name: 'Lock now', exact: true }).click();
  await page.evaluate(() => window.__appLock.releaseLock(0, true));
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Forgot PIN? Sign out' })).toBeVisible();
  expect(await page.evaluate(() => window.__appLock.errors)).toEqual([]);
});

test('open confirmation portals and private toasts leave the DOM with the protected subtree', async ({ page }) => {
  await fixture(page, { notifications: true });
  await page.evaluate(() => window.__appLock.showNotices());
  await expect(page.getByText('PRIVATE-TOAST-MEDICAL-NAME')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('PRIVATE-CONFIRM-DOCUMENT-NAME');
  await page.evaluate(() => window.__appLock.lock());
  await expect(page.getByText('PRIVATE-TOAST-MEDICAL-NAME')).toHaveCount(0);
  await expect(page.getByText('PRIVATE-CONFIRM-DOCUMENT-NAME')).toHaveCount(0);
  await expect(page.getByText('PRIVATE-CONFIRM-DETAILS')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('Enter your PIN');
});

for (const transport of ['both', 'storage', 'broadcast'] as const) {
  test(`Lock now retires another open tab with ${transport} transport`, async ({ context, page }) => {
    if (transport === 'storage') await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
    if (transport === 'broadcast') await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }); });
    await fixture(page);
    const second = await context.newPage();
    await fixture(second);
    await page.evaluate(() => window.__appLock.lock());
    await expect(page.locator('[data-private]')).toHaveCount(0);
    await expect(second.locator('[data-private]')).toHaveCount(0);
    expect(await second.evaluate(() => window.__appLock.unmounts)).toBe(1);
    await page.evaluate(() => window.__appLock.releaseLock(0, true));
    await expect(second).toHaveURL(/\/app-lock\?next=/);
    await expect(second.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
  });
}

test('a new lock fences a pending successful PIN response and cached router children', async ({ page }) => {
  await fixture(page, { locked: true });
  // Dispatch within one task, before React can rerender, as a fast keyboard
  // scanner does. Exactly one complete attempt must reach the action.
  await page.evaluate(() => { for (const key of '40714071') window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
  expect(await page.evaluate(() => window.__appLock.unlockCalls)).toEqual(['4071']);
  await page.evaluate(() => window.__appLock.lock());
  await page.evaluate(() => window.__appLock.releaseUnlock(0, { ok: true }));
  await page.evaluate(() => window.__appLock.render(false, true, 'CACHED-ROUTER-PRIVATE-DATA'));
  await expect(page.locator('[data-private]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__appLock.errors)).toEqual([]);
});

test('an unlock after the gate unmounts cannot navigate, while a current unlock replaces the document', async ({ page }) => {
  await fixture(page, { locked: true });
  await page.keyboard.type('4071');
  await page.evaluate(() => window.__appLock.retire());
  await page.evaluate(() => window.__appLock.releaseUnlock(0, { ok: true }));
  await page.evaluate(() => window.__appLock.render(true));
  await page.keyboard.type('4071');
  await page.evaluate(() => window.__appLock.releaseUnlock(1, { ok: true }));
  await expect(page).toHaveURL(`${ORIGIN}dashboard`);
  await expect(page.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
  await expect(page.locator('[data-private]')).toHaveCount(0);
});

test('a persisted history page retires before its snapshot and reloads on restoration', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('[data-private]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__appLock.unmounts)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
});

test('native back/forward history never restores the retired private document', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.__appLock.lock());
  await page.evaluate(() => window.__appLock.releaseLock(0, true));
  await expect(page).toHaveURL(/\/app-lock\?next=/);
  await expect(page.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
  await page.goto(`${ORIGIN}away`);
  await page.goBack();
  await expect(page.locator('[data-private]')).toHaveCount(0);
  await expect(page.getByText(PRIVATE, { exact: true })).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('[data-private]')).toHaveCount(0);
});

test('reading a newer cross-tab marker before its queued event does not consume retirement', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const key = 'bubaly:app-lock:user-a';
    const newValue = JSON.stringify({ userId: 'user-a', id: 'newer-tab-lock', phase: 'pending' });
    localStorage.setItem(key, newValue);
    window.__appLock.peek();
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  });
  await expect(page.locator('[data-private]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
});

test('a PIN settings change retires and reloads all existing tabs', async ({ context, page }) => {
  await fixture(page);
  const second = await context.newPage();
  await fixture(second);
  await page.evaluate(() => window.__appLock.changed());
  await expect(page.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
  await expect(second.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
});

test('a foreground refusal retires a cached page even when cross-tab transports are unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  });
  await fixture(page);
  await page.evaluate(() => { window.__appLock.status = { ok: false, error: 'Locked' }; window.dispatchEvent(new Event('focus')); });
  await expect(page.locator('[data-private]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/app-lock\?next=/);
  await expect(page.locator('#root')).toHaveText('FRESH-SERVER-DOCUMENT');
});

test('mobile background retirement and an offline foreground check preserve retry and sign out', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__appLock.statusReject = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('[data-private]')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('alert')).toContainText('staying locked');
  await expect(page.getByRole('button', { name: 'Lock now', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forgot PIN? Sign out' })).toBeVisible();
  await expect(page).toHaveURL(ORIGIN);
});

test('settings reads only public status, masks PIN entry and survives save failure without duplicate requests', async ({ page }) => {
  await fixture(page, { settings: true, enabled: false, hasPin: false });
  await page.getByRole('button', { name: 'Set up PIN', exact: true }).click();
  const pin = page.locator('input[type="password"]');
  await expect(pin).toHaveAttribute('autocomplete', 'new-password');
  await pin.fill('4071');
  await expect(page.getByRole('heading', { name: 'Confirm your PIN' })).toBeVisible();
  await page.evaluate(() => { window.__appLock.pendingSave = true; });
  await pin.fill('4071');
  await expect(pin).toBeDisabled();
  await expect(pin).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__appLock.saveCalls)).toEqual([{ enabled: true, pin: '4071' }]);
  await page.evaluate(() => window.__appLock.releaseSave({ ok: false, error: 'Unavailable' }));
  await expect(pin).toBeEnabled();
  await pin.fill('9090');
  await pin.fill('9090');
  expect(await page.evaluate(() => window.__appLock.saveCalls)).toEqual([{ enabled: true, pin: '4071' }, { enabled: true, pin: '9090' }]);
  expect(await page.evaluate(() => window.__appLock.errors)).toEqual([]);
});

test('a failed status read offers no PIN replacement', async ({ page }) => {
  await fixture(page, { settings: true, enabled: false });
  await page.evaluate(() => { window.__appLock.retire(); window.__appLock.status = { ok: false, error: 'Unavailable' }; window.__appLock.render(); });
  await expect(page.getByRole('alert')).toContainText("Couldn't check App Lock");
  await expect(page.getByRole('button', { name: 'Set up PIN', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change PIN', exact: true })).toHaveCount(0);
});
