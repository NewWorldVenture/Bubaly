import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// UI-WF-024 / COMPONENT-C7C7BCE2FA99: "Test this display" on /display/setup,
// walked on the real page as a signed-in Plus parent of a disposable local
// household. The page, its server gate, the component and lib/display/* are
// the real ones; only the browser APIs the checks read are controlled.
//
// What these checks can and cannot prove, as the page itself says:
//   fullscreen — the API is present and permitted here; nothing enters
//                fullscreen, so this is not proof the tablet goes full screen;
//   wake lock  — the browser's answer to one request. A synthetic grant below
//                is the browser saying yes, not a screen that stays on all day
//                (docs/PHYSICAL_DEVICE_TEST_PLAN.md is where that is proved);
//   online     — navigator.onLine, which is not proof Bubaly is reachable;
//   recovery   — the stale-bundle policy answers as designed, not a reload.
// The accessible-tree and live-region assertions are what assistive technology
// is given, not evidence from a person using a screen reader.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const NOT_TESTED = 'Not tested yet';
const COPY = {
  fullscreenAvailable: 'This browser can put the display full screen.',
  fullscreenDisabled: 'The browser has full screen switched off here.',
  wakeLockHeld: 'The screen lock was granted, then handed straight back.',
  wakeLockDeclined: "The browser declined the screen lock. Set the tablet's auto-lock to Never.",
  wakeLockMissing: 'This browser has no screen lock at all.',
  onlineYes: 'The browser reports this device is online. That is not proof Bubaly is reachable.',
  onlineNo: 'The browser reports this device is offline.',
  recoveryReady: 'The recovery rules for a new version are loaded and answering.',
};
const NAMES = ['Full screen', 'Screen stays awake', 'Network', 'Recovery after a new version'];

/** granted / rejected / unavailable / held (the test answers) / native (Chromium's own). */
type WakeLockMode = 'granted' | 'rejected' | 'unavailable' | 'held' | 'native';
type Probe = { mode: WakeLockMode; requests: number; released: boolean[]; answer: () => void };
declare global { interface Window { __wakeLock: Probe } }

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });

async function controlBrowser(context: BrowserContext, mode: WakeLockMode, fullscreenEnabled = true) {
  await context.addInitScript(({ mode, fullscreenEnabled }) => {
    const pending: Array<() => void> = [];
    const probe = window.__wakeLock = {
      mode, requests: 0, released: [] as boolean[],
      answer: () => { pending.shift()?.(); },
    };
    if (!fullscreenEnabled) Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
    if (mode === 'native') return;
    if (mode === 'unavailable') {
      Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => undefined, configurable: true });
      return;
    }
    const lock = {
      request: (type: string) => {
        if (type !== 'screen') return Promise.reject(new TypeError('Unexpected wake lock type'));
        probe.requests += 1;
        if (probe.mode === 'rejected') return Promise.reject(new DOMException('Wake lock refused', 'NotAllowedError'));
        const index = probe.released.push(false) - 1;
        const sentinel = {
          type, released: false,
          release: async () => { sentinel.released = true; probe.released[index] = true; },
          addEventListener: () => {}, removeEventListener: () => {},
        };
        if (probe.mode === 'held') return new Promise((resolve) => { pending.push(() => resolve(sentinel)); });
        return Promise.resolve(sentinel);
      },
    };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => lock, configurable: true });
  }, { mode, fullscreenEnabled });
}

async function signIn(page: Page, account: OwnedAccount) {
  await page.goto('/login?redirect=/display/setup', { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
  } catch { throw new Error('Display self-check E2E could not fill its sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/display\/setup$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Set up this display' })).toBeVisible();
}

const runButton = (page: Page) => page.getByRole('button', { name: 'Run the checks', exact: true });
const statusRegion = (page: Page) => page.getByRole('status').filter({ has: page.getByRole('list') }).filter({ hasText: 'Screen stays awake' });
const rows = (page: Page) => statusRegion(page).getByRole('listitem');
const rowsReading = (details: string[]) => details.map((detail, i) => new RegExp(`^\\s*${escape(NAMES[i])}\\s*${escape(detail)}\\s*$`));
function escape(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }));
}

test.describe('display setup: "Test this display"', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');

  let account: OwnedAccount | null = null;
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    const origin = requireLocalOrigin(provider);
    account = await createOwnedAccount(origin, serviceKey);
    // A Plus household, the plan the setup guide is written for.
    const admin = createClient(origin, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.from('subscriptions')
      .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' });
    if (error) throw new Error('Display self-check E2E could not give its household a Plus plan.');
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });

  test.afterEach(async () => {
    try { await account?.dispose(); } finally { account = null; }
    expect(pageErrors, 'no uncaught page errors').toEqual([]);
  });

  test('keyboard run: four untested rows, answered one at a time, with the control disabled while it runs', async ({ page, context }) => {
    await controlBrowser(context, 'held');
    await signIn(page, account!);

    await expect(rows(page)).toHaveText(rowsReading([NOT_TESTED, NOT_TESTED, NOT_TESTED, NOT_TESTED]));
    await expect(runButton(page)).toBeEnabled();

    await runButton(page).focus();
    await page.keyboard.press('Enter');

    // The wake-lock request is still unanswered: the first row has its answer,
    // the rest have not been reported, and the control cannot start a second run.
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, NOT_TESTED, NOT_TESTED, NOT_TESTED]));
    await expect(runButton(page)).toBeDisabled();
    // Disabled for the run, but still holding the focus that pressed it.
    await expect(runButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(1);

    await page.evaluate(() => window.__wakeLock.answer());
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
    await expect(runButton(page)).toBeEnabled();
    // The lock was handed straight back.
    expect(await page.evaluate(() => window.__wakeLock.released)).toEqual([true]);
    // A keyboard user is left on the control they pressed, not on the page body.
    await expect(runButton(page)).toBeFocused();

    // What assistive technology is given: one polite status region holding the list.
    await expect(statusRegion(page)).toHaveAttribute('aria-live', 'polite');
    await expect(statusRegion(page)).toMatchAriaSnapshot(`
      - status:
        - list:
          - listitem: /Full screen.*${escape(COPY.fullscreenAvailable)}/
          - listitem: /Screen stays awake.*${escape(COPY.wakeLockHeld)}/
          - listitem: /Network.*not proof Bubaly is reachable/
          - listitem: /Recovery after a new version.*${escape(COPY.recoveryReady)}/
    `);
  });

  for (const [mode, detail] of [
    ['granted', COPY.wakeLockHeld],
    ['rejected', COPY.wakeLockDeclined],
    ['unavailable', COPY.wakeLockMissing],
  ] as const) {
    test(`wake lock ${mode}: the row says exactly that, and the other checks still run`, async ({ page, context }) => {
      await controlBrowser(context, mode);
      await signIn(page, account!);
      await runButton(page).click();
      await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, detail, COPY.onlineYes, COPY.recoveryReady]));
      const probe = await page.evaluate(() => ({ requests: window.__wakeLock.requests, released: window.__wakeLock.released }));
      expect(probe).toEqual(mode === 'granted' ? { requests: 1, released: [true] }
        : mode === 'rejected' ? { requests: 1, released: [] }
        : { requests: 0, released: [] });
    });
  }

  test("Chromium's own wake lock answers as held or declined, never as missing (source, not stub)", async ({ page, context }) => {
    await controlBrowser(context, 'native');
    await signIn(page, account!);
    await runButton(page).click();
    await expect(runButton(page)).toBeEnabled();
    const detail = (await rows(page).nth(1).innerText()).replace(NAMES[1], '').trim();
    test.info().annotations.push({ type: 'native wake lock', description: detail });
    expect([COPY.wakeLockHeld, COPY.wakeLockDeclined]).toContain(detail);
  });

  test('offline, then online again: the network row follows navigator.onLine on each run', async ({ page, context }) => {
    await controlBrowser(context, 'granted');
    await signIn(page, account!);
    await context.setOffline(true);
    try {
      await runButton(page).click();
      await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineNo, COPY.recoveryReady]));
    } finally { await context.setOffline(false); }
    await runButton(page).click();
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
  });

  test('fullscreen switched off by the browser is a warning, not a pass', async ({ page, context }) => {
    await controlBrowser(context, 'granted', false);
    await signIn(page, account!);
    await runButton(page).click();
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenDisabled, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
  });

  test('a repeat run starts over from untested rows and asks for the lock again', async ({ page, context }) => {
    await controlBrowser(context, 'held');
    await signIn(page, account!);
    await runButton(page).click();
    await page.evaluate(() => window.__wakeLock.answer());
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));

    await runButton(page).focus();
    await page.keyboard.press('Space');
    // The previous answers are cleared, not left standing as this run's results.
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, NOT_TESTED, NOT_TESTED, NOT_TESTED]));
    await page.evaluate(() => window.__wakeLock.answer());
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
    expect(await page.evaluate(() => window.__wakeLock.released)).toEqual([true, true]);
  });

  test('leaving mid-run hands the lock back; coming back starts from untested rows and runs again', async ({ page, context }) => {
    await controlBrowser(context, 'held');
    await signIn(page, account!);
    await runButton(page).click();
    await expect(runButton(page)).toBeDisabled();

    // Client-side navigation away unmounts the check while its request is open.
    await page.getByRole('link', { name: /See the device list/ }).click();
    await expect(page).toHaveURL(/\/family-display$/);
    await page.evaluate(() => window.__wakeLock.answer());
    await expect.poll(() => page.evaluate(() => window.__wakeLock.released)).toEqual([true]);

    await page.goBack();
    await expect(page).toHaveURL(/\/display\/setup$/);
    await expect(rows(page)).toHaveText(rowsReading([NOT_TESTED, NOT_TESTED, NOT_TESTED, NOT_TESTED]));
    await page.evaluate(() => { window.__wakeLock.mode = 'granted'; });
    await runButton(page).click();
    await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
  });

  for (const width of [390, 1280]) {
    test(`no serious axe violations at ${width} px, before and after a run`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await controlBrowser(context, 'granted');
      await signIn(page, account!);
      expect(await seriousViolations(page)).toEqual([]);
      await runButton(page).click();
      await expect(rows(page)).toHaveText(rowsReading([COPY.fullscreenAvailable, COPY.wakeLockHeld, COPY.onlineYes, COPY.recoveryReady]));
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
});
