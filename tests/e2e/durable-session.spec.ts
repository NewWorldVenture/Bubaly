import { expect, test, type BrowserContext, type Cookie } from '@playwright/test';

/**
 * Signing in lasts until the user signs out.
 *
 * The unit suite (tests/persistent-login.test.ts) pins the RULES — cookie
 * lifetime, what counts as retryable, that sign-out is the only thing that
 * clears a session. What it cannot show is the behaviour those rules produce
 * against a real browser and a real GoTrue: whether the cookie actually
 * survives a restart, whether an expired access token really refreshes instead
 * of bouncing to /login, and whether a burst of parallel requests carrying one
 * expired token rotates the refresh token safely or trips reuse detection and
 * revokes the whole session.
 *
 * That last one is the reason this file exists. Next prefetches, so several
 * requests reach the middleware at once, each seeing the same expired access
 * token; if they each spend the same refresh token outside Supabase's reuse
 * interval, the session dies and the user is thrown out mid-visit.
 *
 * Gated behind E2E_DURABLE_SESSION=1 and a local Supabase, because it signs in
 * as a real user and deliberately mangles that session's cookies.
 *
 *   E2E_DURABLE_SESSION=1 E2E_AUTH_EMAIL=… E2E_AUTH_PASSWORD=… \
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   npx playwright test tests/e2e/durable-session.spec.ts --project=chromium
 */

const enabled = process.env.E2E_DURABLE_SESSION === '1';
const email = process.env.E2E_AUTH_EMAIL ?? '';
const password = process.env.E2E_AUTH_PASSWORD ?? '';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;
/** A signed-in page shows the app chrome; /login shows the sign-in form. */
const SIGNED_IN = /\/(home|dashboard|admin)/;

function requireLocalSupabase(): void {
  if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  const { hostname } = new URL(supabaseUrl);
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!local && process.env.E2E_ALLOW_REMOTE_SUPABASE !== '1') {
    throw new Error(`Refusing to mangle sessions against remote Supabase host ${hostname}.`);
  }
}

const authCookies = (cookies: Cookie[]) => cookies.filter((c) => AUTH_COOKIE.test(c.name));

/** The stored session, reassembled from however many chunks it occupies. */
function readSession(cookies: Cookie[]): Record<string, unknown> | null {
  const parts = authCookies(cookies).sort((a, b) => a.name.localeCompare(b.name));
  if (parts.length === 0) return null;
  let raw = parts.map((c) => c.value).join('');
  if (raw.startsWith('base64-')) {
    raw = Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8');
  }
  try {
    return JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

async function signIn(context: BrowserContext, baseURL: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2000);
  await page.close();
}

/**
 * Rewrite the stored session so its access token reads as long expired, leaving
 * the refresh token intact — the state a browser is in after being closed for
 * an hour. The next request must refresh rather than sign the user out.
 */
async function expireAccessToken(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const session = readSession(cookies);
  expect(session, 'expected a stored session to expire').not.toBeNull();

  session!.expires_at = Math.floor(Date.now() / 1000) - 3600;
  session!.expires_in = 0;

  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const template = authCookies(cookies)[0];
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += 3180) chunks.push(encoded.slice(i, i + 3180));

  const base = template.name.replace(/\.\d+$/, '');
  await context.clearCookies();
  await context.addCookies(
    chunks.map((value, index) => ({
      name: chunks.length === 1 ? base : `${base}.${index}`,
      value,
      domain: template.domain,
      path: template.path,
      expires: template.expires,
      httpOnly: template.httpOnly,
      secure: template.secure,
      sameSite: template.sameSite,
    })),
  );
}

test.describe('a signed-in user stays signed in until they sign out', () => {
  test.skip(!enabled, 'Set E2E_DURABLE_SESSION=1 to run the durable-session journey.');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    requireLocalSupabase();
    if (!email || !password) throw new Error('E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD are required.');
  });

  test('the session cookie outlives the tab', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signIn(context, baseURL!);

    const stored = authCookies(await context.cookies());
    expect(stored.length, 'signing in should store an auth cookie').toBeGreaterThan(0);

    for (const cookie of stored) {
      // -1 is a session cookie: it dies with the browser. Anything else is an
      // absolute expiry, and it has to be far enough out to be a real "stay
      // signed in" rather than a few hours' grace.
      expect(cookie.expires, `${cookie.name} must not be a session cookie`).toBeGreaterThan(0);
      const daysAway = (cookie.expires * 1000 - Date.now()) / 86_400_000;
      expect(daysAway, `${cookie.name} should last months, not hours`).toBeGreaterThan(30);
      expect(cookie.path).toBe('/');
    }
    await context.close();
  });

  test('closing and reopening the browser keeps you signed in', async ({ browser, baseURL }) => {
    const first = await browser.newContext();
    await signIn(first, baseURL!);
    const state = await first.storageState();
    await first.close();

    // A brand-new context with only the persisted cookies is what a browser
    // restart actually looks like.
    const second = await browser.newContext({ storageState: state });
    const page = await second.newPage();
    await page.goto(`${baseURL}/home`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(SIGNED_IN);
    await second.close();
  });

  test('an expired access token refreshes instead of signing you out', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signIn(context, baseURL!);
    const before = readSession(await context.cookies());
    await expireAccessToken(context);

    const page = await context.newPage();
    await page.goto(`${baseURL}/home`, { waitUntil: 'domcontentloaded' });
    await expect(page, 'an expired access token must not become a logout').toHaveURL(SIGNED_IN);

    const after = readSession(await context.cookies());
    expect(after, 'the session should still be stored').not.toBeNull();
    expect(after!.access_token, 'the access token should have been rotated').not.toBe(before!.access_token);
    await context.close();
  });

  test('a burst of parallel requests on one expired token does not revoke the session', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signIn(context, baseURL!);
    await expireAccessToken(context);

    // Every one of these reaches the middleware holding the same expired access
    // token and the same refresh token — the shape Next's prefetching produces.
    // If they each spend that refresh token, reuse detection revokes the family
    // and the user is signed out mid-visit.
    const targets = ['/home', '/dashboard', '/dashboard/calendar', '/dashboard/todos', '/dashboard/meals', '/dashboard/chores'];
    const request = context.request;
    const responses = await Promise.all(
      targets.map((path) => request.get(`${baseURL}${path}`, { maxRedirects: 0 })),
    );
    for (const [index, response] of responses.entries()) {
      const location = response.headers().location ?? '';
      expect(location, `${targets[index]} must not redirect to /login`).not.toContain('/login');
    }

    // And the session must still work afterwards, not merely have survived the burst.
    const page = await context.newPage();
    await page.goto(`${baseURL}/home`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(SIGNED_IN);
    await context.close();
  });

  test('signing out is what ends it', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    await signIn(context, baseURL!);

    const page = await context.newPage();
    await page.goto(`${baseURL}/home`, { waitUntil: 'domcontentloaded' });
    await page.request.post(`${baseURL}/auth/signout`, { form: {}, maxRedirects: 0 });

    // The jar may still hold the cookie NAME after an expiry write; what matters
    // is that it carries no session any more, and that the app agrees.
    const leftover = authCookies(await context.cookies());
    for (const cookie of leftover) {
      expect(cookie.value, `${cookie.name} must not still hold a session`).toBe('');
    }
    await page.goto(`${baseURL}/home`, { waitUntil: 'domcontentloaded' });
    await expect(page, 'after sign-out the app must ask you to sign in again').toHaveURL(/\/login/);
    await context.close();
  });
});
