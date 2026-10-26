import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// The real server page and ScopedLocaleProvider are resolved before mounting
// their real LocaleProvider/SignOutForm output in Chromium. Database/auth
// failures and the browser session adapter are controlled; Next transport and
// actual cookie removal are covered by their dedicated integration suites.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries([
  'app/app-lock/page.tsx', 'components/auth/sign-out-form.tsx',
  'components/i18n/scoped-locale-provider.tsx', 'components/i18n/locale-provider.tsx',
  'lib/i18n/locales.ts', 'lib/i18n/scopes.ts', 'lib/i18n/translate.ts', 'lib/auth/redirect.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

type Probe = {
  current: string | null; unavailable: boolean; calls: string[]; navigations: string[];
  refreshes: number; payload: string; errors: string[]; privateReads: number;
};
declare global { interface Window { __unavailableLock: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function fixture(page: Page, locale = 'en-US', authFailure = false) {
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(appLock\.|signOutButton\.)/.test(key))) as Record<string, string>;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto('https://unavailable-lock-fixture.invalid/app-lock?next=%2Fdashboard');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `void (async () => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, modules = {};
    const localeCode = ${JSON.stringify(locale)}, authFailure = ${JSON.stringify(authFailure)};
    const p = window.__unavailableLock = { current: 'session-a', unavailable: false, calls: [],
      navigations: [], refreshes: 0, payload: '', errors: [], privateReads: 0 };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const router = { replace: href => p.navigations.push(href), refresh: () => p.refreshes++ };
    const mocks = {
      react: React,
      'next/navigation': { useRouter: () => router, redirect: href => { throw new Error('Unexpected redirect: ' + href); } },
      '@/lib/time/zoned': { isValidTimezone: () => true },
      '@/lib/supabase/errors': { rememberDbErrorText: () => () => {} },
      '@/lib/i18n/server': {
        getTranslations: async () => key => messages[key] ?? key,
        getLocaleContext: async () => ({ locale: load('@/lib/i18n/locales').localeOrDefault(localeCode), source: 'cookie', messages }),
      },
      '@/lib/supabase/server': { createServer: async () => ({ auth: { getUser: async () => ({
        data: { user: { id: 'USER-ID-MUST-NOT-LEAK', user_metadata: { name: 'PRIVATE-FAMILY-NAME' } } },
        error: authFailure ? new Error('PRIVATE-AUTH-DIAGNOSTIC') : null,
      }) } }) },
      '@/lib/security/app-lock-store': { readAppLockRecord: async () => {
        p.privateReads++;
        return { ok: false, error: new Error('PRIVATE-STORE-DIAGNOSTIC-HASH-SALT') };
      } },
      '@/components/app/app-lock-boundary': { AppLockBoundary: () => { throw new Error('No PIN may be requested when the store is unavailable'); } },
      '@/components/auth/session-keeper': { SessionKeeper: () => { throw new Error('Unavailable output must not mount private session props'); } },
      '@/lib/auth/browser-signout': {
        captureSignOutIntent: () => p.current ? { session: p.current } : null,
        signOutBrowserSession: intent => {
          p.calls.push(intent.session);
          if (p.unavailable) return { status: 'unavailable' };
          if (p.current !== intent.session) return { status: 'session-changed' };
          p.current = null;
          return { status: 'signed-out', revocation: Promise.resolve('confirmed') };
        },
        isBrowserSignedOut: () => p.current === null,
      },
    };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const ScopedLocaleProvider = load('@/components/i18n/scoped-locale-provider').ScopedLocaleProvider;
    async function resolveServer(node) {
      if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
      if (!React.isValidElement(node)) return node;
      if (node.type === ScopedLocaleProvider) return resolveServer(await node.type(node.props));
      const { children, ...props } = node.props;
      return children === undefined ? node : React.createElement(node.type, props, await resolveServer(children));
    }
    const output = await load('@/app/app-lock/page').default({ searchParams: Promise.resolve({ next: '/dashboard?private=PRIVATE-RETURN-TARGET' }) });
    const tree = await resolveServer(output);
    p.payload = JSON.stringify(tree, (key, value) => key === '_owner' ? undefined : typeof value === 'function' ? value.name : value);
    ReactDOM.flushSync(() => ReactDOM.createRoot(document.getElementById('root')).render(tree));
  })();` });
  await expect(page.locator('form[action="/auth/signout"]')).toBeVisible();
  return messages;
}

for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
  test(`${locale}: unavailable private storage has a translated sign-out escape and no private payload`, async ({ page }) => {
    const messages = await fixture(page, locale);
    await expect(page.getByRole('heading')).toHaveText(messages['appLock.weCouldNotConfirmYourLockSettings']);
    await expect(page.getByText(messages['appLock.stayingLockedUntilWeCanCheck'], { exact: true })).toBeVisible();
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(1);
    const payload = await page.evaluate(() => window.__unavailableLock.payload);
    for (const privateText of ['USER-ID-MUST-NOT-LEAK', 'PRIVATE-FAMILY-NAME', 'PRIVATE-AUTH-DIAGNOSTIC',
      'PRIVATE-STORE-DIAGNOSTIC-HASH-SALT', 'PRIVATE-RETURN-TARGET']) expect(payload).not.toContain(privateText);
    expect(await page.evaluate(() => window.__unavailableLock.privateReads)).toBe(1);
    const button = page.getByRole('button', { name: messages['signOutButton.signOut'], exact: true });
    await expect(page.locator('form')).toHaveAttribute('method', 'post');
    // Force the actual client form through its translated session-review UI;
    // this fails if the server page omits its scoped locale provider.
    await page.evaluate(() => { window.__unavailableLock.current = 'session-b'; });
    await button.click();
    await expect(page.getByRole('alert')).toContainText(messages['signOutButton.sessionChanged']);
    await page.getByRole('button', { name: messages['signOutButton.reviewSession'], exact: true }).click();
    await expect(page.getByRole('status')).toContainText(messages['signOutButton.sessionReviewed']);
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => ({ current: window.__unavailableLock.current, calls: window.__unavailableLock.calls,
      navigations: window.__unavailableLock.navigations, refreshes: window.__unavailableLock.refreshes, errors: window.__unavailableLock.errors })))
      .toEqual({ current: null, calls: ['session-a', 'session-b'], navigations: ['/login'], refreshes: 1, errors: [] });
  });
}

test('an authentication-service failure also preserves sign out without reading private storage', async ({ page }) => {
  const messages = await fixture(page, 'en-US', true);
  expect(await page.evaluate(() => window.__unavailableLock.privateReads)).toBe(0);
  await page.getByRole('button', { name: messages['signOutButton.signOut'], exact: true }).click();
  expect(await page.evaluate(() => ({ current: window.__unavailableLock.current, navigations: window.__unavailableLock.navigations })))
    .toEqual({ current: null, navigations: ['/login'] });
});

test('a failed local sign-out reports the failure and can be reviewed and retried', async ({ page }) => {
  const messages = await fixture(page, 'fr-FR');
  await page.evaluate(() => { window.__unavailableLock.unavailable = true; });
  const button = page.getByRole('button', { name: messages['signOutButton.signOut'], exact: true });
  await button.click();
  await expect(page.getByRole('alert')).toContainText(messages['signOutButton.sessionUnavailable']);
  expect(await page.evaluate(() => window.__unavailableLock.current)).toBe('session-a');
  await page.evaluate(() => { window.__unavailableLock.unavailable = false; });
  await page.getByRole('button', { name: messages['signOutButton.reviewSession'], exact: true }).click();
  await button.click();
  expect(await page.evaluate(() => ({ current: window.__unavailableLock.current, navigations: window.__unavailableLock.navigations })))
    .toEqual({ current: null, navigations: ['/login'] });
});
