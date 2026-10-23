import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// household-roles N3-R1-APPLOCK-FOCUS. A family behind the paywall or the
// closed-account gate is shown the social accounts still connected, and a
// parent who set an App Lock PIN has those behind the lock (N2-R1-APPLOCK).
// Round 3 put the lock INSIDE the gate: two modal dialogs, one in the other.
// React runs a child's passive effects before its parent's, so the lock's
// focus trap went on the stack first and the gate's on top of it; the gate,
// top-most, focused its own first control and answered Tab, and the lock's
// trap stood inert. Reproduced in Chromium: focus began on the paywall's
// "Choose" (the closed gate's "Reopen my account") behind "Enter your PIN",
// and Tab walked the gate's controls before it reached the keypad.
//
// The layout now draws one dialog at a time: with App Lock on and the session
// locked, the lock screen is drawn IN PLACE OF the gate. Driven here: the REAL
// (app) layout, resolved as the server would, and the REAL TrialPaywallGate,
// AccountClosedGate, AppLockGate, Button, use-dialog-behavior and
// use-lock-body-scroll, in Chromium, by keyboard. Only the layout's server
// reads (the session, the plan, the preference row, the accounts), the
// translator, the toast, the actions and the sign-out form are stand-ins.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries([
  'app/(app)/layout.tsx',
  'components/app/app-lock-gate.tsx', 'components/app/trial-paywall-gate.tsx', 'components/app/account-closed-gate.tsx',
  'components/ui/button.tsx', 'lib/a11y/use-dialog-behavior.ts', 'lib/hooks/use-lock-body-scroll.ts',
  'lib/security/app-lock.ts', 'lib/wallet/ledger.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>)
  .filter(([key]) => /^(trialPaywallGate\.|accountClosedGate\.|appLockGate\.|stepUp\.)/.test(key)));

const PIN = '4821';
const salt = randomBytes(16).toString('hex');
const APP_LOCK = { enabled: true, salt, hash: createHash('sha256').update(`${salt}:${PIN}`).digest('hex') };
const USER = 'a0000000-0000-4000-8000-000000000001';
const CARD = 'Accounts still connected';

type Scenario = {
  gate: 'paywall' | 'closed';
  /** The accounts card the layout hands the gate (null: nothing left to disconnect). */
  left: boolean;
  /** notification_prefs.appLock, or 'unreadable' for a refused read. */
  appLock: typeof APP_LOCK | { enabled: false; salt: string; hash: string } | null | 'unreadable';
  /** This tab already took the PIN (sessionStorage). */
  unlocked?: boolean;
};
type Probe = { mounted: boolean; errors: string[]; settle: () => Promise<void> };
declare global { interface Window { __lockOverGate: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function fixture(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route('**/*', async route => {
    if (route.request().isNavigationRequest() && route.request().url() === 'https://lock-over-gate-fixture.invalid/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' });
    } else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await page.goto('https://lock-over-gate-fixture.invalid/');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, scenario = ${JSON.stringify(scenario)};
    const USER = ${JSON.stringify(USER)}, CARD = ${JSON.stringify(CARD)}, modules = {};
    const p = window.__lockOverGate = { mounted: false, errors: [] };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const consoleError = console.error;
    console.error = (...args) => { p.errors.push(args.map(String).join(' ')); consoleError(...args); };
    if (scenario.unlocked) sessionStorage.setItem('bubaly_applock_unlocked_' + USER, '1');
    const h = React.createElement, pass = ({ children }) => children;
    const t = key => messages[key] ?? key;
    // The layout's server reads, as the database would answer them.
    const server = {
      auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
      from: table => {
        if (table !== 'user_preferences') throw new Error('Unexpected table: ' + table);
        const query = { select: () => query, eq: () => query, maybeSingle: async () => scenario.appLock === 'unreadable'
          ? { data: null, error: { message: 'permission denied for table user_preferences', code: '42501' } }
          : { data: scenario.appLock ? { notification_prefs: { appLock: scenario.appLock } } : null, error: null } };
        return query;
      },
    };
    const mocks = {
      react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => h('a', props, children) },
      '@/lib/supabase/server': { createServer: async () => server },
      '@/lib/supabase/auth': { isSuperAdmin: async () => false },
      '@/lib/i18n/server': { getTranslations: async () => t },
      '@/lib/server/family-time-zone': { activeFamilyTimeZone: async () => 'UTC' },
      '@/lib/server/entitlement': {
        resolveEntitlement: async () => ({ closed: scenario.gate === 'closed', locked: scenario.gate === 'paywall', familyId: 'f-1', trialEndsAt: '2026-09-01T00:00:00.000Z' }),
        closedFamilyStanding: async () => ({ canReopen: true, openFamilies: [] }),
      },
      '@/lib/social/left-connected': { accountsLeftConnectedBehindTheGate: async () => scenario.left ? { accounts: [{ id: 'x-1' }] } : null },
      // The card itself is drawn by tests/a-family-behind-the-paywall-can-still-disconnect-x.test.ts:
      // here it is a heading and the one control it carries.
      '@/components/social/accounts-left-connected': { AccountsLeftConnected: () => h('section', { 'aria-label': CARD }, h('h2', null, CARD), h('button', { type: 'button' }, 'Disconnect')) },
      '@/components/i18n/scoped-locale-provider': { ScopedLocaleProvider: pass },
      '@/components/i18n/locale-provider': { useTranslations: () => t, useLocale: () => ({ code: 'en-US' }), FamilyTimeZoneProvider: pass },
      '@/components/ui/confirm': { ConfirmProvider: pass },
      '@/components/auth/session-keeper': { SessionKeeper: () => null },
      '@/components/auth/sign-out-form': { SignOutForm: ({ children, className }) => h('form', { action: '/auth/signout', method: 'post', className }, children({ signingOut: false })) },
      '@/components/auth/step-up-form': { StepUpForm: () => null },
      '@/lib/auth/step-up-client': { reportRefusal: () => undefined },
      '@/components/ui/toast': { useToast: () => ({ success() {}, error() {}, toast() {} }) },
      '@/app/(app)/account/actions': { closeAccountAction: async () => { throw new Error('not under test'); }, reopenAccountAction: async () => { throw new Error('not under test'); } },
      '@/app/(app)/actions': { setActiveFamilyAction: async () => { throw new Error('not under test'); } },
      '@/lib/constants/plans': { BASIC_ANNUAL_CENTS: 11988, PLUS_ANNUAL_CENTS: 23988 },
      '@/lib/marketing/value': { PLAN_CURRENCY: 'USD' },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    };
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    // Await every server component, depth first, as the server renders the
    // layout; the client components are left for React in the page.
    async function resolveServer(node) {
      if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
      if (!React.isValidElement(node)) return node;
      if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') return resolveServer(await node.type(node.props));
      if (!Object.prototype.hasOwnProperty.call(node.props, 'children')) return node;
      const children = await resolveServer(node.props.children);
      return React.cloneElement(node, {}, ...(Array.isArray(children) ? children : [children]));
    }
    const AppGroupLayout = load('@/app/(app)/layout').default;
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    (async () => {
      const element = await resolveServer(await AppGroupLayout({ children: h('main', { id: 'the-app' }, 'THE-APP') }));
      ReactDOM.flushSync(() => ReactDOM.createRoot(document.getElementById('root')).render(element));
      p.mounted = true;
    })().catch(error => p.errors.push(String(error && error.stack || error)));
  })();` });
  await page.waitForFunction(() => window.__lockOverGate.mounted || window.__lockOverGate.errors.length > 0);
  await page.evaluate(() => window.__lockOverGate.settle());
  return { unexpected, errors: () => page.evaluate(() => window.__lockOverGate.errors) };
}

/** Where focus is, and which dialogs are on the page. */
const where = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const lock = document.querySelector('[aria-labelledby="app-lock-title"]');
  return {
    dialogs: dialogs.map(dialog => dialog.getAttribute('aria-labelledby')),
    inLock: Boolean(lock && active && lock.contains(active)),
    inDialog: dialogs.some(dialog => active && dialog.contains(active)),
    focused: active ? (active.getAttribute('aria-label') || active.textContent || active.tagName).trim() : null,
  };
});
const LOCK = 'app-lock-title';
const KEYPAD_AND_ESCAPE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', messages['appLockGate.forgotPinSignOut']];

for (const [gate, title, firstControl] of [
  ['paywall', 'paywall-title', 'Choose'],
  ['closed', 'closed-title', messages['accountClosedGate.reopenMyAccount']],
] as const) {
  test.describe(`behind the ${gate === 'paywall' ? 'paywall' : 'closed-account gate'}, a parent with App Lock on`, () => {
    test('meets the lock alone: focus starts on its keypad, and Tab and Shift+Tab never leave it', async ({ page }) => {
      const { unexpected, errors } = await fixture(page, { gate, left: true, appLock: APP_LOCK });
      await expect(page.getByRole('dialog', { name: messages['appLockGate.enterYourPin'] })).toBeVisible();
      const start = await where(page);
      expect(start, 'focus starts on the keypad, not on a control behind the lock').toMatchObject({ inLock: true, focused: '1' });
      expect(start.dialogs, 'one dialog at a time: the lock, in place of the gate').toEqual([LOCK]);
      // Nothing of the gate is on the page to be reached, or pressed with Enter.
      await expect(page.getByRole('button', { name: firstControl })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
      await expect(page.getByText(CARD)).toHaveCount(0);

      const forward: string[] = [];
      for (let i = 0; i < KEYPAD_AND_ESCAPE.length + 2; i++) {
        await page.keyboard.press('Tab');
        const now = await where(page);
        expect(now.inLock, `Tab ${i + 1} stays inside the lock (it reached "${now.focused}")`).toBe(true);
        forward.push(now.focused!);
      }
      // Every keypad key and the sign-out escape, in order, and round again.
      expect(forward).toEqual([...KEYPAD_AND_ESCAPE.slice(1), KEYPAD_AND_ESCAPE[0], ...KEYPAD_AND_ESCAPE.slice(1, 3)]);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Shift+Tab');
        expect((await where(page)).inLock, `Shift+Tab ${i + 1} stays inside the lock`).toBe(true);
      }
      expect(await errors()).toEqual([]);
      expect(unexpected).toEqual([]);
    });

    test('types the PIN and then meets the gate, focused inside it, with the accounts and their Disconnect', async ({ page }) => {
      const { errors } = await fixture(page, { gate, left: true, appLock: APP_LOCK });
      await page.keyboard.type(PIN);
      await expect(page.getByRole('dialog', { name: messages['appLockGate.enterYourPin'] })).toHaveCount(0);
      await page.evaluate(() => window.__lockOverGate.settle());
      const after = await where(page);
      expect(after.dialogs).toEqual([title]);
      expect(after).toMatchObject({ inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
      expect(await errors()).toEqual([]);
    });

    test('in a tab already unlocked with the PIN, meets the gate and its accounts at once (control)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: APP_LOCK, unlocked: true });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('with App Lock switched off, meets the gate and its accounts as before (control)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: { ...APP_LOCK, enabled: false } });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('when the lock setting cannot be read, meets the gate without the accounts (closed, as the app is)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: 'unreadable' });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByText(CARD)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    });

    test('with nothing left connected, meets the gate as before, with no lock (control)', async ({ page }) => {
      await fixture(page, { gate, left: false, appLock: APP_LOCK });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
    });
  });
}
