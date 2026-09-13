import { expect, test as base, type BrowserContext, type Cookie } from '@playwright/test';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { syntheticChildEmail } from '../../lib/onboarding/child-login';
import { deriveChildPassword } from '../../lib/onboarding/child-password';
import {
  authCookieName, authCookies, closeWithoutSnapshot, createOwnedAccount,
  expireStoredSession, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

const enabled = process.env.E2E_DURABLE_SESSION === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
type OwnedChild = { username: string; pin: string; userId: string; dispose: () => Promise<void> };

async function createOwnedChild(account: OwnedAccount): Promise<OwnedChild> {
  // Refuse remote providers before reading configuration or making a request.
  const origin = requireLocalOrigin(provider);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const secret = process.env.CHILD_LOGIN_SECRET ?? '';
  if (!serviceKey || !secret) throw new Error('Durable-session child E2E requires disposable backend and child-login configuration.');
  const admin = createClient<Database>(origin, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) },
  });
  const username = `ds${randomBytes(10).toString('hex')}`;
  const pin = String(randomInt(0, 10_000)).padStart(4, '0');
  const memberId = randomUUID(), loginId = randomUUID();
  let userId: string | null = null;
  let disposed = false;
  async function dispose() {
    if (disposed || !userId) return;
    // The throttle has no family FK. Remove only this unique owned username;
    // all remaining deletes also carry the owned user/member/family predicates.
    const operations = [
      () => admin.from('child_login_throttle').delete().eq('username', username),
      () => admin.from('child_logins').delete().eq('id', loginId).eq('family_id', account.familyId).eq('user_id', userId!),
      () => admin.from('family_members').delete().eq('id', memberId).eq('family_id', account.familyId).eq('user_id', userId!),
      () => admin.auth.admin.deleteUser(userId!),
    ];
    let failed = false;
    for (const operation of operations) {
      try { const { error } = await operation(); failed ||= !!error; } catch { failed = true; }
    }
    if (failed) throw new Error('Durable-session E2E could not clean up its owned child fixture.');
    disposed = true;
  }
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email: syntheticChildEmail(username), email_confirm: true,
      // Derivation stays in this private Node setup and the real server action.
      // Only the username and PIN are ever supplied to the browser form.
      password: deriveChildPassword(secret, username, pin),
      user_metadata: { child: true, family_id: account.familyId, member_id: memberId, username, display_name: 'SessionKid' },
    });
    if (error || !data.user) throw new Error();
    userId = data.user.id;
    const member = await admin.from('family_members').insert({
      id: memberId, family_id: account.familyId, user_id: userId, role: 'child', display_name: 'SessionKid', is_active: true,
    });
    if (member.error) throw new Error();
    const login = await admin.from('child_logins').insert({
      id: loginId, family_id: account.familyId, member_id: memberId, user_id: userId, username, created_by: account.userId,
    });
    if (login.error) throw new Error();
    const preferences = await admin.from('user_preferences').upsert({
      user_id: userId, active_family_id: account.familyId, notification_prefs: { onboardingComplete: true },
    }, { onConflict: 'user_id' });
    if (preferences.error) throw new Error();
    return { username, pin, userId, dispose };
  } catch {
    await dispose();
    throw new Error('Durable-session E2E could not initialize its owned child fixture.');
  }
}

const test = base.extend<{ account: OwnedAccount; childAccount: OwnedChild }>({
  account: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
  childAccount: async ({ account }, runFixture) => {
    const child = await createOwnedChild(account);
    try { await runFixture(child); } finally { await child.dispose(); }
  },
});
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

async function signIn(context: BrowserContext, origin: string, account: OwnedAccount) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
    // Catch credential-bearing Playwright call failures and replace their logs.
    try {
      await page.locator('input[name="email"]').fill(account.email);
      await page.locator('input[name="password"]').fill(account.password);
    } catch { throw new Error('Durable-session E2E could not fill its sign-in form.'); }
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
    const session = readSession(await context.cookies(), authCookieName(provider));
    expect(session.user.id === account.userId, 'The browser must belong to its owned fixture').toBe(true);
  } finally { await page.close(); }
}

async function visitProtected(context: BrowserContext, origin: string) {
  const page = await context.newPage();
  try {
    const response = await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), 'Protected content must load successfully').toBe(200);
    await expect(page).toHaveURL(`${origin}/home`);
    await expect(page.getByRole('button', { name: 'Quick capture', exact: true })).toBeVisible();
  } finally { await page.close(); }
}

async function signInChild(context: BrowserContext, origin: string, child: OwnedChild) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/kid-login`, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('input[name="username"]').fill(child.username);
      await page.locator('input[name="pin"]').fill(child.pin);
    } catch { throw new Error('Durable-session E2E could not fill its child sign-in form.'); }
    // Real React form -> real Next server action -> disposable GoTrue -> guarded
    // browser adoption. No intercepted login response or injected auth session.
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: 'SessionKid' })).toBeVisible();
    expect(readSession(await context.cookies(), authCookieName(provider)).user.id === child.userId, 'PIN login must save the owned child identity').toBe(true);
  } finally { await page.close(); }
}

async function visitChildProtected(context: BrowserContext, origin: string, child: OwnedChild) {
  const page = await context.newPage();
  try {
    const response = await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), 'The child must retain protected access').toBe(200);
    await expect(page).toHaveURL(`${origin}/home`);
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: 'SessionKid' })).toBeVisible();
    expect(readSession(await context.cookies(), authCookieName(provider)).user.id === child.userId).toBe(true);
  } finally { await page.close(); }
}

test.describe('durable browser session against disposable GoTrue', () => {
  test.skip(!enabled, 'Requires E2E_DURABLE_SESSION=1 and the disposable local Supabase.');
  test.setTimeout(90_000);

  test('child PIN login survives cookie-only reopening until explicit sign-out and preserves another device and parent', async ({ browser, baseURL, account, childAccount }) => {
    test.setTimeout(120_000);
    const origin = requireLocalOrigin(baseURL), name = authCookieName(provider);
    const contexts = new Set<BrowserContext>();
    async function newContext() {
      const context = await browser.newContext({ locale: 'en-US' });
      contexts.add(context);
      return context;
    }
    try {
      const first = await newContext(), otherDevice = await newContext(), parent = await newContext();
      await signIn(parent, origin, account);
      await signInChild(first, origin, childAccount);
      await signInChild(otherDevice, origin, childAccount);
      const persisted = authCookies(await first.cookies(), name);
      expect(persisted.length > 0, 'Child PIN login must save persistent auth cookies').toBe(true);
      for (const cookie of persisted) {
        expect((cookie.expires * 1000 - Date.now()) / 86_400_000).toBeGreaterThan(30);
        expect(cookie.path).toBe('/');
      }
      await closeWithoutSnapshot(first);
      contexts.delete(first);
      let reopened: BrowserContext;
      try {
        reopened = await browser.newContext({ storageState: { cookies: persisted.filter(cookie => cookie.expires > 0), origins: [] }, locale: 'en-US' });
      } catch { throw new Error('Durable-session E2E could not restore its child cookies in memory.'); }
      contexts.add(reopened);
      await visitChildProtected(reopened, origin, childAccount);
      const before = readSession(await reopened.cookies(), name);
      await expireStoredSession(reopened, name);
      await visitChildProtected(reopened, origin, childAccount);
      expect(readSession(await reopened.cookies(), name).refresh_token !== before.refresh_token, 'The reopened child session must perform a real token refresh').toBe(true);

      const page = await reopened.newPage();
      try {
        await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        const [revocation] = await Promise.all([
          page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.origin === requireLocalOrigin(provider) && url.pathname === '/auth/v1/logout' && response.request().method() === 'POST';
          }),
          page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click(),
        ]);
        expect(revocation.status(), 'The disposable provider must confirm the explicit child logout').toBe(204);
        expect(new URL(revocation.url()).searchParams.get('scope')).toBe('local');
        await expect(page).toHaveURL(/\/login(?:\?|$)/);
        expect(authCookies(await reopened.cookies(), name).every(cookie => cookie.value === ''), 'Explicit child sign-out must clear this browser session').toBe(true);
        await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/login(?:\?|$)/);
      } finally { await page.close(); }

      // A real refresh on each independent context proves local logout did not
      // revoke the child's second device or the parent's separate account.
      await expireStoredSession(otherDevice, name);
      await visitChildProtected(otherDevice, origin, childAccount);
      await expireStoredSession(parent, name);
      await visitProtected(parent, origin);
      expect(readSession(await parent.cookies(), name).user.id === account.userId).toBe(true);
    } finally {
      const closed = await Promise.allSettled([...contexts].map(closeWithoutSnapshot));
      if (closed.some(result => result.status === 'rejected')) throw new Error('Durable-session E2E could not close its child browser contexts.');
    }
  });

  test('persistent cookies survive a fresh browser context without local storage', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL);
    const first = await browser.newContext({ locale: 'en-US' });
    let persisted: Cookie[] = [];
    try {
      await signIn(first, origin, account);
      persisted = authCookies(await first.cookies(), authCookieName(provider));
      expect(persisted.length > 0, 'Sign-in must save auth cookies').toBe(true);
      for (const cookie of persisted) {
        expect((cookie.expires * 1000 - Date.now()) / 86_400_000).toBeGreaterThan(30);
        expect(cookie.path).toBe('/');
      }
    } finally { await closeWithoutSnapshot(first); }
    // Copy only persistent cookies in memory, never session cookies, local
    // storage, a profile directory, or an auth-state artifact.
    let second: BrowserContext;
    try { second = await browser.newContext({ storageState: { cookies: persisted.filter((cookie) => cookie.expires > 0), origins: [] }, locale: 'en-US' }); }
    catch { throw new Error('Durable-session E2E could not restore its in-memory cookies.'); }
    try { await visitProtected(second, origin); } finally { await closeWithoutSnapshot(second); }
  });

  test('stored access-token expiry triggers a real refresh that remains usable', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL);
    const context = await browser.newContext({ locale: 'en-US' });
    const name = authCookieName(provider);
    try {
      await signIn(context, origin, account);
      const before = readSession(await context.cookies(), name);
      await expireStoredSession(context, name);
      await visitProtected(context, origin);
      const after = readSession(await context.cookies(), name);
      expect(after.refresh_token !== before.refresh_token, 'GoTrue must rotate the refresh token').toBe(true);
      expect(after.expires_at > Date.now() / 1000, 'The refreshed session must have a future expiry').toBe(true);
      expect(after.user.id === account.userId, 'Refresh must retain the account identity').toBe(true);
      // A second real refresh proves that the first response saved a usable
      // refresh token, not just a still-valid access JWT.
      await expireStoredSession(context, name);
      await visitProtected(context, origin);
      expect(readSession(await context.cookies(), name).refresh_token !== after.refresh_token).toBe(true);
    } finally { await closeWithoutSnapshot(context); }
  });

  test('parallel requests carrying one expired session leave a refreshable session', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL);
    const context = await browser.newContext({ locale: 'en-US' });
    const name = authCookieName(provider);
    try {
      await signIn(context, origin, account);
      await expireStoredSession(context, name);
      const cookie = (await context.cookies(origin)).map((item) => `${item.name}=${item.value}`).join('; ');
      const before = readSession(await context.cookies(), name);
      const paths = ['/home', '/dashboard', '/dashboard/calendar', '/dashboard/todos', '/dashboard/notes', '/dashboard/grocery'];
      // Pin every outgoing Cookie header to the same expired state;
      // context.request still applies response cookies to the browser jar.
      const responses = await Promise.all(paths.map(async (path) => {
        try { return await context.request.get(`${origin}${path}`, { headers: { Cookie: cookie }, maxRedirects: 0 }); }
        catch { throw new Error('Durable-session E2E parallel request failed.'); }
      }));
      for (const response of responses) {
        expect(response.status(), 'Each protected request must succeed').toBe(200);
        await response.dispose();
      }
      const after = readSession(await context.cookies(), name);
      expect(after.refresh_token !== before.refresh_token, 'The burst must produce a rotated refresh token').toBe(true);
      await expireStoredSession(context, name);
      await visitProtected(context, origin);
      const final = readSession(await context.cookies(), name);
      expect(final.refresh_token !== after.refresh_token, 'The stored token must still refresh after the burst').toBe(true);
      expect(final.user.id === account.userId).toBe(true);
    } finally { await closeWithoutSnapshot(context); }
  });

  test('explicit local sign-out clears this browser and preserves another device', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL);
    const context = await browser.newContext({ locale: 'en-US' });
    let otherDevice: BrowserContext | undefined;
    const name = authCookieName(provider);
    try {
      otherDevice = await browser.newContext({ locale: 'en-US' });
      await signIn(context, origin, account);
      await signIn(otherDevice, origin, account);
      let response;
      try {
        response = await context.request.post(`${origin}/auth/signout`, {
          headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, form: { scope: 'local' }, maxRedirects: 0,
        });
      } catch { throw new Error('Durable-session E2E sign-out request failed.'); }
      expect(response.status()).toBe(303);
      const completion = new URL(response.headers().location, origin);
      expect(completion.pathname).toBe('/auth/signout/complete');
      // The POST revokes the submitted token but sends no auth-cookie deletion
      // that could erase a later login. Its matched browser continuation clears.
      expect(response.headers()['set-cookie'] ?? '').not.toContain(`${name}=`);
      await response.dispose();
      const page = await context.newPage();
      try {
        await page.goto(completion.href, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/login(?:\?|$)/);
        expect(authCookies(await context.cookies(), name).every((cookie) => cookie.value === ''), 'Explicit sign-out must clear this session').toBe(true);
        await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/login(?:\?|$)/);
      } finally { await page.close(); }
      await expireStoredSession(otherDevice, name);
      await visitProtected(otherDevice, origin);
      expect(readSession(await otherDevice.cookies(), name).user.id === account.userId).toBe(true);
    } finally {
      const closed = await Promise.allSettled([closeWithoutSnapshot(context), ...(otherDevice ? [closeWithoutSnapshot(otherDevice)] : [])]);
      if (closed.some((result) => result.status === 'rejected')) throw new Error('Durable-session E2E could not close its browser contexts.');
    }
  });
});
