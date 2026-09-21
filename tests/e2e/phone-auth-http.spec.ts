import { createClient } from '@supabase/supabase-js';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import {
  authCookieName, authCookies, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

// Actual Next UI and disposable GoTrue. CI configures only these reserved
// fictional numbers with fixed OTPs. Inert provider config satisfies the CLI;
// a mandatory closed-loopback SMS hook prevents any external provider contact.
// Fixed test codes are reusable, so this does not assert delivery or code expiry.
const enabled = process.env.E2E_AUTHENTICATED === '1' && process.env.E2E_DURABLE_SESSION === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const phones = [
  { number: '+12025550101', code: '483921' },
  { number: '+12025550102', code: '483922' },
  { number: '+12025550103', code: '483923' },
] as const;
const test = base.extend<{ account: OwnedAccount; replacement: OwnedAccount }>({
  account: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
  replacement: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
});
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

async function bindOwnedPhone(account: OwnedAccount, phone: string) {
  const origin = requireLocalOrigin(provider);
  if (!phones.some(entry => entry.number === phone)) throw new Error('Phone HTTP fixture refuses an unconfigured number.');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Phone HTTP fixture requires the disposable service key.');
  const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }) } });
  try {
    const result = await admin.auth.admin.updateUserById(account.userId, { phone, phone_confirm: true });
    if (result.error || result.data.user?.id !== account.userId || result.data.user.phone !== phone.slice(1)) {
      throw new Error('Phone HTTP fixture could not bind its owned disposable account.');
    }
  } finally { await admin.auth.dispose(); }
}

async function signIn(page: Page, origin: string, account: OwnedAccount) {
  await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
  } catch { throw new Error('Phone HTTP fixture could not fill its owned sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
  expect(readSession(await page.context().cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname === '/login').toBe(true);
  expect(authCookies(await page.context().cookies(), authCookieName(provider)).length).toBe(0);
}

async function requestCode(page: Page, origin: string, phone: string) {
  const providerOrigin = requireLocalOrigin(provider);
  await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue with phone', exact: true }).click();
  await page.getByRole('textbox', { name: 'Phone number', exact: true }).fill(phone.slice(2));
  const sent = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === providerOrigin && url.pathname === '/auth/v1/otp' && response.request().method() === 'POST';
  }, { timeout: 30_000 }).then(async response => {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === 'object' && 'error_code' in body ? body.error_code : null;
    const known = ['phone_provider_disabled', 'sms_send_failed', 'over_sms_send_rate_limit',
      'hook_timeout', 'hook_timeout_after_retry', 'hook_payload_over_size_limit', 'hook_invalid_payload', 'unexpected_failure'];
    // Only bounded status/known error metadata enters assertions, never the
    // body, phone, account, request headers or provider diagnostic message.
    return { status: response.status(), errorCode: code === null ? null
      : typeof code === 'string' && known.includes(code) ? code : 'unrecognized_error' };
  }).catch(() => ({ status: 0, errorCode: 'response_unavailable' }));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await sent, 'Disposable GoTrue must accept the configured test-number OTP request')
    .toEqual({ status: 200, errorCode: null });
  await expect(page.getByRole('heading', { name: 'Enter the code we sent you', exact: true })).toBeVisible({ timeout: 30_000 });
}

async function enterCode(page: Page, code: string) {
  // Paste through the actual segmented input handler. Replacing a rejected code
  // in one event avoids accidentally submitting six intermediate edits.
  //
  // The ClipboardEvent is CONSTRUCTED IN THE PAGE rather than handed to
  // `locator.dispatchEvent('paste', { clipboardData })`, and that is the whole
  // reason these three tests could never pass. Playwright's injected
  // dispatchEvent switches on an event-type map with entries for mouse,
  // keyboard, touch, pointer, focus, drag, wheel and the motion events — there
  // is no clipboard entry — so 'paste' falls to the default arm and it builds
  // `new Event('paste', init)`. Event's init dictionary silently DROPS the
  // unknown `clipboardData` member. React's ClipboardEventInterface then reads
  // `'clipboardData' in e ? e.clipboardData : window.clipboardData`, which is
  // undefined in Chromium, and OtpInput's handler calls `.getData('text')` on
  // it and throws before publishing a digit. onChange and onComplete never run,
  // verify() is never called, and no POST reaches /auth/v1/verify — which is
  // exactly what observeVerify() sat waiting thirty seconds for.
  //
  // None of that was ever true of a real user: a real paste carries a real
  // ClipboardEvent, and typing digit by digit does not go through handlePaste
  // at all. The defect was in this helper.
  //
  // Not switched to six fill() calls: the comment above is right that replacing
  // an already-full code one digit at a time fires onComplete on every edit,
  // because each intermediate value is still six digits long. This spec only
  // runs under the chromium project, so DataTransfer and the ClipboardEvent
  // constructor are both available.
  await page.getByRole('textbox', { name: 'Digit 1', exact: true }).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.setData('text/plain', value);
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
    }));
  }, code);
  // The code really landed. Without this the next failure is thirty seconds
  // later and says only `Expected: true / Received: false`, naming nothing —
  // which is how the original defect stayed unidentified across six CI runs.
  await expect(page.getByRole('textbox', { name: 'Digit 1', exact: true })).toHaveValue(code.slice(0, 1));
  await expect(page.getByRole('textbox', { name: 'Digit 6', exact: true })).toHaveValue(code.slice(5, 6));
}

function sessionBytes(context: BrowserContext) {
  return context.cookies().then(cookies => JSON.stringify(authCookies(cookies, authCookieName(provider))
    .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))));
}

type Receipt = { success: boolean; ownedUser: boolean; tokens: boolean; cookieNeutral: boolean };
async function observeVerify(page: Page, userId: string, hold = false) {
  const origin = requireLocalOrigin(provider), receipts: Receipt[] = [];
  let released = false, failed = false, delivered = 0, release = () => {};
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  await page.route(url => url.origin === origin && url.pathname === '/auth/v1/verify', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      try {
        const body: unknown = await response.json();
        const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        const user = value.user && typeof value.user === 'object' ? value.user as Record<string, unknown> : {};
        receipts.push({ success: response.ok(), ownedUser: user.id === userId,
          tokens: typeof value.access_token === 'string' && !!value.access_token && typeof value.refresh_token === 'string' && !!value.refresh_token,
          cookieNeutral: !response.headers()['set-cookie'] });
        // Capture boolean metadata before delivery; never retain token bodies in
        // traces, logs, assertions or response handles after browser navigation.
        if (hold && !released) await gate;
        await route.fulfill({ response }); delivered++;
      } finally { await response.dispose().catch(() => {}); }
    } catch { failed = true; await route.abort().catch(() => {}); }
  });
  return {
    receipts, release,
    wait: async (count: number) => {
      // expect.poll THROWS on timeout, so the assertion below — the one
      // carrying the only human-readable message — is unreachable in exactly
      // the case that fires. What CI printed for six runs was a bare
      // `Expected: true / Received: false`, which names nothing and is why the
      // real cause (a paste event with no clipboardData, see enterCode) went
      // unidentified. Fold the diagnosis into the failure itself.
      try {
        await expect.poll(() => failed || receipts.length >= count, { timeout: 30_000 }).toBe(true);
      } catch {
        throw new Error(
          `No GoTrue /auth/v1/verify receipt after 30s: ${receipts.length} of ${count} observed, ` +
          `${delivered} delivered, route fetch failed=${failed}. ZERO observed means the POST was ` +
          'never issued at all, so the flow never reached verification — check that the code ' +
          'actually landed in the digit boxes before suspecting the app.');
      }
      expect(failed, 'The real local GoTrue verification response must be readable').toBe(false);
    },
    delivered: async (count: number) => {
      await expect.poll(() => failed || delivered >= count, { timeout: 30_000 }).toBe(true);
      expect(failed, 'The original GoTrue response must be delivered unchanged').toBe(false);
    },
  };
}

test.describe('phone login through real Next and disposable GoTrue', () => {
  test.skip(!enabled, 'Requires authenticated and durable-session CI flags with the disposable local Supabase.');
  test.setTimeout(120_000);

  test('wrong code is refused and a valid phone session survives reload and another tab until production logout', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    try {
      await bindOwnedPhone(account, phones[0].number);
      const page = await context.newPage(), probe = await observeVerify(page, account.userId);
      await requestCode(page, origin, phones[0].number);
      await enterCode(page, '000000'); await probe.wait(1); await probe.delivered(1);
      expect(probe.receipts[0]).toEqual({ success: false, ownedUser: false, tokens: false, cookieNeutral: true });
      await expect(page.getByRole('button', { name: 'Verify & continue', exact: true })).toBeEnabled();
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
      await enterCode(page, phones[0].code); await probe.wait(2); await probe.delivered(2);
      expect(probe.receipts[1]).toEqual({ success: true, ownedUser: true, tokens: true, cookieNeutral: true });
      await expect(page).toHaveURL(`${origin}/home`, { timeout: 30_000 });
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(`${origin}/home`);
      const other = await context.newPage(); await other.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
      await expect(other).toHaveURL(`${origin}/home`);
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
      await signOut(other);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => new URL(page.url()).pathname === '/login').toBe(true);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
    } finally { await closeWithoutSnapshot(context); }
  });

  for (const decision of ['logout', 'newer-password'] as const) {
    test(`held genuine SMS verification cannot replace ${decision}`, async ({ browser, baseURL, account, replacement }) => {
      const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
      let release = () => {};
      try {
        const phone = phones[decision === 'logout' ? 1 : 2];
        await bindOwnedPhone(account, phone.number);
        const choosing = await context.newPage(); await signIn(choosing, origin, account);
        const page = await context.newPage(), probe = await observeVerify(page, account.userId, true); release = probe.release;
        await requestCode(page, origin, phone.number); await enterCode(page, phone.code); await probe.wait(1);
        expect(probe.receipts[0]).toEqual({ success: true, ownedUser: true, tokens: true, cookieNeutral: true });
        if (decision === 'logout') await signOut(choosing);
        else await signIn(choosing, origin, replacement);
        const before = await sessionBytes(context);
        probe.release(); await probe.delivered(1);
        await expect(page.getByRole('button', { name: 'Verify & continue', exact: true })).toBeEnabled();
        expect(new URL(page.url()).pathname).toBe('/login');
        expect(await sessionBytes(context) === before, 'An older real SMS receipt must preserve the later auth decision byte-for-byte').toBe(true);
        if (decision === 'logout') expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
        else expect(readSession(await context.cookies(), authCookieName(provider)).user.id === replacement.userId).toBe(true);
      } finally { release(); await closeWithoutSnapshot(context); }
    });
  }
});
