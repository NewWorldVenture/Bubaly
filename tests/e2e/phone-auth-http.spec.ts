import { createClient } from '@supabase/supabase-js';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import {
  authCookieName, authCookies, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

// Actual Next UI and disposable GoTrue. CI configures only these reserved
// fictional numbers with fixed OTPs; no SMS provider is configured or contacted.
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
  await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue with phone', exact: true }).click();
  await page.getByRole('textbox', { name: 'Phone number', exact: true }).fill(phone.slice(2));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enter the code we sent you', exact: true })).toBeVisible({ timeout: 30_000 });
}

async function enterCode(page: Page, code: string) {
  // Paste through the actual segmented input handler. Replacing a rejected code
  // in one event avoids accidentally submitting six intermediate edits.
  const data = await page.evaluateHandle(value => { const transfer = new DataTransfer(); transfer.setData('text/plain', value); return transfer; }, code);
  try { await page.getByRole('textbox', { name: 'Digit 1', exact: true }).dispatchEvent('paste', { clipboardData: data }); }
  finally { await data.dispose(); }
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
      await expect.poll(() => failed || receipts.length >= count, { timeout: 30_000 }).toBe(true);
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
