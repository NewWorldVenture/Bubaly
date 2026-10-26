import fs from 'node:fs';
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
// locked, the lock screen is drawn IN PLACE OF the gate. Since main's
// server-side App Lock (4569189e0, 81ca007b4) that is the layout's own
// decision: it reads the private lock record before billing, and a locked
// browser is sent AppLockBoundary's lock screen alone, the gate and its card
// included; the PIN goes to unlockAppAction, and a right one opens a fresh
// document, which the server renders as the gate with its accounts.
//
// Driven here: the REAL (app) layout, resolved as the server would, and the
// REAL AppLockBoundary, app-lock-browser, AppLockGate, TrialPaywallGate,
// AccountClosedGate, Button, use-dialog-behavior and use-lock-body-scroll, in
// Chromium, by keyboard. Only the layout's server reads (the session, the
// private lock record and this browser's unlock, the plan, the accounts), the
// translator, the toast, the actions and the sign-out form are stand-ins. The
// document is served at /app-lock, where AppLockBoundary sends every locked
// browser (openLockScreen), so the lock screen there is the one the member
// meets and stays put for the keyboard.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries([
  'app/(app)/layout.tsx',
  'components/app/app-lock-boundary.tsx', 'lib/security/app-lock-browser.ts', 'lib/offline/cache.ts',
  'components/app/app-lock-gate.tsx', 'components/app/trial-paywall-gate.tsx', 'components/app/account-closed-gate.tsx',
  'components/ui/button.tsx', 'lib/a11y/use-dialog-behavior.ts', 'lib/hooks/use-lock-body-scroll.ts',
  'lib/wallet/ledger.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>)
  .filter(([key]) => /^(trialPaywallGate\.|accountClosedGate\.|appLockGate\.|appLock\.|signOutButton\.|stepUp\.)/.test(key)));

const PIN = '4821';
const USER = 'a0000000-0000-4000-8000-000000000001';
const CARD = 'Accounts still connected';
const ORIGIN = 'https://lock-over-gate-fixture.invalid';
const LOCK_PAGE = `${ORIGIN}/app-lock?next=%2Fdashboard`;

type Scenario = {
  gate: 'paywall' | 'closed';
  /** The accounts card the layout hands the gate (null: nothing left to disconnect). */
  left: boolean;
  /** The member's private App Lock record: on, off, none, or a read that is refused. */
  appLock: 'on' | 'off' | null | 'unreadable';
  /** This browser already holds the server's unlock (a right PIN was entered). */
  unlocked?: boolean;
};
type Probe = { mounted: boolean; errors: string[]; unlockCalls: string[]; settle: () => Promise<void> };
declare global { interface Window { __lockOverGate: Probe } }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

async function fixture(page: Page, scenario: Scenario) {
  const unexpected: string[] = [];
  await page.route('**/*', async route => {
    if (route.request().isNavigationRequest() && route.request().url().startsWith(`${ORIGIN}/`)) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' });
    } else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await page.goto(LOCK_PAGE);
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, messages = ${JSON.stringify(messages)}, scenario = ${JSON.stringify(scenario)};
    const USER = ${JSON.stringify(USER)}, CARD = ${JSON.stringify(CARD)}, PIN = ${JSON.stringify(PIN)}, modules = {};
    const p = window.__lockOverGate = { mounted: false, errors: [], unlockCalls: [] };
    window.addEventListener('error', event => p.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const consoleError = console.error;
    console.error = (...args) => { p.errors.push(args.map(String).join(' ')); consoleError(...args); };
    const h = React.createElement, pass = ({ children }) => children;
    const t = key => messages[key] ?? key;
    // The layout's server reads, as the server would answer them.
    const server = {
      auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
      from: table => { throw new Error('Unexpected table: ' + table); },
    };
    const UNLOCK = 'unlocked-by-the-server';
    const record = scenario.appLock === 'on' || scenario.appLock === 'off'
      ? { userId: USER, revision: 'r-1', config: { enabled: scenario.appLock === 'on', salt: 'private', hash: 'private' } }
      : null;
    const mocks = {
      react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      'next/link': { default: ({ children, ...props }) => h('a', props, children) },
      'next/headers': { cookies: async () => ({ get: name => (scenario.unlocked && name === 'bubaly_app_unlock' ? { name, value: UNLOCK } : undefined) }) },
      '@/lib/supabase/server': { createServer: async () => server },
      '@/lib/security/app-lock-store': { readAppLockRecord: async () => (scenario.appLock === 'unreadable'
        ? { ok: false, error: new Error('permission denied for table app_lock_credentials') }
        : { ok: true, record }) },
      '@/lib/security/app-lock-server': {
        APP_UNLOCK_COOKIE: 'bubaly_app_unlock',
        readAppLockSessionId: async () => 'session-1',
        isAppUnlocked: (userId, lock, sessionId, value) => userId === USER && lock.config?.enabled === true && sessionId === 'session-1' && value === UNLOCK,
      },
      // The server checks the PIN; a right one sets this browser's unlock.
      '@/app/(app)/settings/app-lock-actions': {
        unlockAppAction: async pin => { p.unlockCalls.push(pin); return pin === PIN ? { ok: true } : { ok: false, reason: 'wrong_pin' }; },
        getAppLockSettings: async () => ({ ok: true, enabled: true, hasPin: true }),
        lockAppAction: async () => ({ ok: true }),
      },
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
      '@/components/auth/sign-out-form': { SignOutForm: ({ children, className }) => h('form', { action: '/auth/signout', method: 'post', className },
        typeof children === 'function' ? children({ signingOut: false }) : children) },
      '@/components/auth/step-up-form': { StepUpForm: () => null },
      '@/lib/auth/step-up-client': { reportRefusal: () => undefined },
      '@/components/ui/toast': { useToast: () => ({ success() {}, error() {}, toast() {} }), ToastProvider: pass },
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
      const { unexpected, errors } = await fixture(page, { gate, left: true, appLock: 'on' });
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

    test('types the PIN, the server takes it, and the fresh document is the gate, focused inside it, with the accounts and their Disconnect', async ({ page }) => {
      const locked = await fixture(page, { gate, left: true, appLock: 'on' });
      // The keypad answers the keyboard; a right PIN opens a fresh document.
      await page.keyboard.type(PIN.slice(0, 3));
      expect(await page.evaluate(() => window.__lockOverGate.unlockCalls)).toEqual([]);
      expect(await locked.errors()).toEqual([]);
      const fresh = page.waitForEvent('framenavigated');
      await page.keyboard.type(PIN.slice(3));
      await fresh;
      expect(locked.unexpected).toEqual([]);
      // That document, rendered by the server with the unlock it set.
      const unlocked = await fixture(page, { gate, left: true, appLock: 'on', unlocked: true });
      await expect(page.getByRole('dialog', { name: messages['appLockGate.enterYourPin'] })).toHaveCount(0);
      await page.evaluate(() => window.__lockOverGate.settle());
      const after = await where(page);
      expect(after.dialogs).toEqual([title]);
      expect(after).toMatchObject({ inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
      // The gate with its card renders cleanly once unlocked.
      expect(await unlocked.errors()).toEqual([]);
      expect(unlocked.unexpected).toEqual([]);
    });

    test('a wrong PIN keeps the lock alone on the page (control)', async ({ page }) => {
      const { errors } = await fixture(page, { gate, left: true, appLock: 'on' });
      await page.keyboard.type('0000');
      await expect.poll(() => page.evaluate(() => window.__lockOverGate.unlockCalls)).toEqual(['0000']);
      await page.evaluate(() => window.__lockOverGate.settle());
      expect((await where(page)).dialogs).toEqual([LOCK]);
      await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
      expect(await errors()).toEqual([]);
    });

    test('in a browser already unlocked with the PIN, meets the gate and its accounts at once (control)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: 'on', unlocked: true });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('with App Lock switched off, meets the gate and its accounts as before (control)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: 'off' });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });

    test('when the lock setting cannot be read, meets neither the gate nor the accounts: the app is withheld (closed)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: 'unreadable' });
      await expect(page.getByRole('heading', { name: messages['appLock.weCouldNotConfirmYourLockSettings'] })).toBeVisible();
      expect((await where(page)).dialogs, 'no dialog: there is no PIN to check, and no gate to show').toEqual([]);
      await expect(page.getByRole('button', { name: firstControl })).toHaveCount(0);
      await expect(page.getByText(CARD)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    });

    test('with nothing left connected, still meets the lock alone: the gate itself is behind the PIN', async ({ page }) => {
      await fixture(page, { gate, left: false, appLock: 'on' });
      expect(await where(page)).toMatchObject({ dialogs: [LOCK], inLock: true, focused: '1' });
      await expect(page.getByRole('button', { name: firstControl })).toHaveCount(0);
    });

    test('with no App Lock set, meets the gate and its accounts as before (control)', async ({ page }) => {
      await fixture(page, { gate, left: true, appLock: null });
      expect(await where(page)).toMatchObject({ dialogs: [title], inDialog: true, focused: firstControl });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    });
  });
}
