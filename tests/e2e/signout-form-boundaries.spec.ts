import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Real React, modal, form and all six consumers. Session storage/removal is a
// controlled contract here; the browser-signout tests exercise that boundary.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries([
  'components/auth/sign-out-form.tsx', 'components/auth/sign-out-button.tsx', 'components/auth/step-up-form.tsx',
  'components/settings/privacy-center.tsx', 'components/app/account-closed-gate.tsx', 'components/app/app-lock-gate.tsx',
  'components/app/trial-paywall-gate.tsx', 'components/ui/modal.tsx', 'components/ui/button.tsx', 'components/ui/card.tsx',
  'lib/hooks/use-lock-body-scroll.ts', 'lib/auth/mfa.ts', 'lib/constants/roles.ts', 'lib/security/app-lock.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

type Control = 'plain' | 'confirmation' | 'step-up' | 'privacy' | 'closed' | 'lock' | 'trial';
type Probe = {
  current: string | null; canCapture: boolean; unavailable: boolean; switchDuringSignout: boolean; captures: number;
  calls: string[]; navigations: string[]; refreshes: number; errors: string[]; prevented: number;
  mount: (control?: Control) => void; retire: () => void; captureSubmit: () => void; fireCaptured: (count?: number) => void;
  releaseRevocation: (outcome: 'confirmed' | 'unconfirmed') => void; settle: () => Promise<void>;
};
declare global { interface Window { __signoutForm: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function fixture(page: Page, control: Control = 'plain', locale = 'en-US') {
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')))
    .filter(([key]) => /^(signOutButton\.|modal\.|stepUp\.|privacyCenter\.|accountClosedGate\.|appLockGate\.|trialPaywallGate\.)/.test(key)));
  await page.route('**/*', async route => {
    if (route.request().isNavigationRequest() && route.request().url() === 'https://signout-form-fixture.invalid/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' });
    } else throw new Error(`Unexpected request in controlled sign-out fixture: ${route.request().url()}`);
  });
  await page.goto('https://signout-form-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, modules = {};
    const p = window.__signoutForm = { current: 'session-a', canCapture: true, unavailable: false, switchDuringSignout: false,
      captures: 0, calls: [], navigations: [], refreshes: 0, errors: [], prevented: 0 };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const previousConsoleError = console.error;
    console.error = (...args) => { p.errors.push(args.map(String).join(' ')); previousConsoleError(...args); };
    let root, captured, release;
    const router = { replace: href => p.navigations.push(href), push: href => p.navigations.push(href), refresh: () => p.refreshes++ };
    const mocks = {
      react: React, 'react-dom': ReactDOM, 'next/navigation': { useRouter: () => router },
      'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
      '@/components/ui/toast': { useToast: () => ({ success() {}, error() {} }) },
      '@/components/app/app-context': { useApp: () => ({ role: 'child', members: [], userEmail: 'fixture@example.invalid' }) },
      '@/app/(app)/account/actions': { reopenAccountAction: async () => { throw new Error('Unrelated action'); }, closeAccountAction: async () => { throw new Error('Unrelated action'); } },
      '@/lib/constants/plans': { BASIC_ANNUAL_CENTS: 11988, PLUS_ANNUAL_CENTS: 23988 },
      '@/lib/utils/format': { fmtDateTime: value => value },
      '@/components/ui/otp-input': { OtpInput: () => null },
      '@/components/auth/mfa-error-copy': { MfaErrorNotice: () => null },
      '@/lib/supabase/client': { createClient: () => ({ auth: {
        getUser: async () => ({ data: { user: { id: 'fixture-user' } }, error: null }),
        mfa: { listFactors: async () => ({ data: { all: [] }, error: null }),
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) }
      } }) },
      '@/lib/auth/browser-signout': {
        captureSignOutIntent: () => { p.captures++; return p.canCapture && p.current ? { session: p.current } : null; },
        signOutBrowserSession: intent => {
          p.calls.push(intent.session);
          if (p.unavailable) return { status: 'unavailable' };
          if (p.current !== intent.session) return { status: 'session-changed' };
          p.current = p.switchDuringSignout ? 'session-b' : null;
          return { status: 'signed-out', revocation: new Promise(resolve => { release = resolve; }) };
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
    const controls = {
      confirmation: [load('@/components/auth/sign-out-button').SignOutButton, {}],
      'step-up': [load('@/components/auth/step-up-form').StepUpForm, { next: '/home', serverReadFailed: false }],
      privacy: [load('@/components/settings/privacy-center').PrivacyCenter, {}],
      closed: [load('@/components/app/account-closed-gate').AccountClosedGate, {}],
      lock: [load('@/components/app/app-lock-gate').AppLockGate, { enabled: true, salt: 'fixture-salt', hash: 'fixture-hash', userId: 'fixture-user' }],
      trial: [load('@/components/app/trial-paywall-gate').TrialPaywallGate, {}],
    };
    const SignOutForm = load('@/components/auth/sign-out-form').SignOutForm;
    p.mount = (control = 'plain') => {
      root ??= ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(React.StrictMode, null, control === 'plain'
        ? React.createElement(SignOutForm, null, ({ signingOut }) => React.createElement('button', { type: 'submit', disabled: signingOut }, 'Fixture sign out'))
        : React.createElement(controls[control][0], controls[control][1]))));
    };
    p.retire = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.captureSubmit = () => {
      const form = document.querySelector('form[action="/auth/signout"]');
      captured = form[Object.keys(form).find(key => key.startsWith('__reactProps$'))].onSubmit;
    };
    p.fireCaptured = (count = 1) => { for (let i = 0; i < count; i++) captured({ preventDefault: () => p.prevented++ }); };
    p.releaseRevocation = outcome => release(outcome);
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    p.mount(${JSON.stringify(control)});
  })();` });
  await page.evaluate(() => window.__signoutForm.settle());
  return messages as Record<string, string>;
}

async function openForm(page: Page, control: Control) {
  if (control === 'confirmation') await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('form[action="/auth/signout"]')).toBeVisible();
}

for (const control of ['confirmation', 'step-up', 'privacy', 'closed', 'lock', 'trial'] as const) {
  test(`${control} keeps its sign-out control usable and signs out exactly once with keyboard confirmation`, async ({ page }) => {
    await fixture(page, control);
    await openForm(page, control);
    const form = page.locator('form[action="/auth/signout"]');
    await expect(form).toHaveAttribute('method', 'post');
    await form.locator('button[type="submit"]').focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls,
      navigations: window.__signoutForm.navigations, refreshes: window.__signoutForm.refreshes, errors: window.__signoutForm.errors })))
      .toEqual({ current: null, calls: ['session-a'], navigations: ['/login'], refreshes: 1, errors: [] });
  });

  test(`${control} preserves a changed account until an explicit review and second sign-out decision`, async ({ page }) => {
    await fixture(page, control);
    await openForm(page, control);
    await page.evaluate(() => { window.__signoutForm.current = 'session-b'; });
    await page.locator('form[action="/auth/signout"] button[type="submit"]').click();
    await expect(page.getByRole('alert')).toContainText('Your sign-in changed');
    expect(await page.evaluate(() => ({ current: window.__signoutForm.current, navigations: window.__signoutForm.navigations })))
      .toEqual({ current: 'session-b', navigations: [] });
    await page.getByRole('button', { name: 'Review session', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Current session checked');
    expect(await page.evaluate(() => window.__signoutForm.current)).toBe('session-b');
    await page.locator('form[action="/auth/signout"] button[type="submit"]').click();
    expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls,
      navigations: window.__signoutForm.navigations, errors: window.__signoutForm.errors })))
      .toEqual({ current: null, calls: ['session-a', 'session-b'], navigations: ['/login'], errors: [] });
  });
}

test('confirmation captures the account on opening and cancellation changes no session', async ({ page }) => {
  await fixture(page, 'confirmation');
  expect(await page.evaluate(() => window.__signoutForm.captures)).toBe(0);
  await page.evaluate(() => { window.__signoutForm.current = 'session-b'; });
  await openForm(page, 'confirmation');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls })))
    .toEqual({ current: 'session-b', calls: [] });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openForm(page, 'confirmation');
  await page.locator('form button[type="submit"]').click();
  expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual(['session-b']);
});

test('duplicate handlers are fenced synchronously before React rerenders', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__signoutForm; p.captureSubmit(); p.fireCaptured(3); });
  expect(await page.evaluate(() => ({ calls: window.__signoutForm.calls, prevented: window.__signoutForm.prevented })))
    .toEqual({ calls: ['session-a'], prevented: 3 });
});

test('a cancelled confirmation handler cannot submit the next opened confirmation', async ({ page }) => {
  await fixture(page, 'confirmation');
  await openForm(page, 'confirmation');
  await page.evaluate(() => window.__signoutForm.captureSubmit());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { window.__signoutForm.current = 'session-b'; });
  await openForm(page, 'confirmation');
  await page.evaluate(() => window.__signoutForm.fireCaptured());
  expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls })))
    .toEqual({ current: 'session-b', calls: [] });
  await page.locator('form button[type="submit"]').click();
  expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual(['session-b']);
});

test('an unavailable review can be repeated without submitting an uncaptured session', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__signoutForm; p.retire(); p.canCapture = false; p.mount(); });
  await page.getByRole('button', { name: 'Fixture sign out' }).click();
  await page.getByRole('button', { name: 'Review session' }).click();
  await expect(page.getByRole('alert')).toContainText('Your session could not be checked');
  await page.getByRole('button', { name: 'Fixture sign out' }).click();
  expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual([]);
  await page.evaluate(() => { window.__signoutForm.canCapture = true; });
  await page.getByRole('button', { name: 'Review session' }).click();
  await expect(page.getByRole('status')).toContainText('Current session checked');
  await page.getByRole('button', { name: 'Fixture sign out' }).click();
  expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual(['session-a']);
});

test('a submit captured from an unmounted form cannot sign out a new account', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__signoutForm; p.captureSubmit(); p.retire(); p.current = 'session-b'; p.fireCaptured(); });
  expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls,
    navigations: window.__signoutForm.navigations, prevented: window.__signoutForm.prevented })))
    .toEqual({ current: 'session-b', calls: [], navigations: [], prevented: 1 });
});

test('an earlier submit handler stays invalid after the current session is reviewed', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__signoutForm; p.captureSubmit(); p.current = 'session-b'; p.fireCaptured(); });
  await page.getByRole('button', { name: 'Review session' }).click();
  await page.evaluate(() => window.__signoutForm.fireCaptured());
  expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls })))
    .toEqual({ current: 'session-b', calls: ['session-a'] });
  await page.getByRole('button', { name: 'Fixture sign out' }).click();
  expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual(['session-a', 'session-b']);
});

for (const cause of ['capture', 'removal'] as const) {
  test(`${cause} unavailable reports failure and requires review before retry`, async ({ page }) => {
    await fixture(page);
    await page.evaluate(cause => {
      const p = window.__signoutForm;
      if (cause === 'capture') { p.retire(); p.canCapture = false; p.mount(); }
      else p.unavailable = true;
    }, cause);
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    await expect(page.getByRole('alert')).toContainText('Your session could not be checked');
    const initialCalls = cause === 'capture' ? [] : ['session-a'];
    expect(await page.evaluate(() => ({ current: window.__signoutForm.current, calls: window.__signoutForm.calls,
      navigations: window.__signoutForm.navigations }))).toEqual({ current: 'session-a', calls: initialCalls, navigations: [] });
    await page.evaluate(() => { const p = window.__signoutForm; p.canCapture = true; p.unavailable = false; });
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    expect(await page.evaluate(() => window.__signoutForm.calls)).toEqual(initialCalls);
    await page.getByRole('button', { name: 'Review session' }).click();
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    expect(await page.evaluate(() => window.__signoutForm.current)).toBeNull();
  });
}

for (const outcome of ['confirmed', 'unconfirmed'] as const) {
  test(`late ${outcome} revocation never signs out or navigates a replacement account`, async ({ page }) => {
    await fixture(page);
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    await page.evaluate(outcome => { const p = window.__signoutForm; p.retire(); p.current = 'session-b'; p.navigations = []; p.releaseRevocation(outcome); }, outcome);
    await page.evaluate(() => window.__signoutForm.settle());
    expect(await page.evaluate(() => ({ current: window.__signoutForm.current, navigations: window.__signoutForm.navigations,
      errors: window.__signoutForm.errors }))).toEqual({ current: 'session-b', navigations: [], errors: [] });
  });
}

test('a session arriving before the navigation check is preserved on the current page', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { window.__signoutForm.switchDuringSignout = true; });
  await page.getByRole('button', { name: 'Fixture sign out' }).click();
  await expect(page.getByRole('alert')).toContainText('Your sign-in changed');
  expect(await page.evaluate(() => ({ current: window.__signoutForm.current, navigations: window.__signoutForm.navigations })))
    .toEqual({ current: 'session-b', navigations: [] });
});

for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
  test(`${locale} shows translated review and failure states`, async ({ page }) => {
    const messages = await fixture(page, 'plain', locale);
    await page.evaluate(() => { window.__signoutForm.current = 'session-b'; });
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    await expect(page.getByRole('alert')).toContainText(messages['signOutButton.sessionChanged']);
    await page.getByRole('button', { name: messages['signOutButton.reviewSession'], exact: true }).click();
    await expect(page.getByRole('status')).toContainText(messages['signOutButton.sessionReviewed']);
    await page.evaluate(() => { window.__signoutForm.unavailable = true; });
    await page.getByRole('button', { name: 'Fixture sign out' }).click();
    await expect(page.getByRole('alert')).toContainText(messages['signOutButton.sessionUnavailable']);
    expect(await page.evaluate(() => window.__signoutForm.errors)).toEqual([]);
  });
}
