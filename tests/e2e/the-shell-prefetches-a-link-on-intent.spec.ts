import { expect, test, type Locator, type Page } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// PERF-001. The app shell's own links (the sidebar, the top bar, the phone's
// tab bar, the notification bell, the logo) are on screen on every page, and a Next
// <Link> prefetches every link on screen. Over ten member pages that was 40
// prefetch requests a page load on average, each one through middleware.ts's
// session lookup and App Lock read before Next renders anything. They are
// IntentLinks now (components/ui/intent-link.tsx): a link prefetches when
// someone may follow it, the pointer over it or keyboard focus on it.
//
// Signed in to a disposable local household at 1280 px, where the sidebar is
// drawn: loading a page prefetches none of the routes only the shell links to;
// pointing at a sidebar link, or focusing one, prefetches its route; and the
// link still opens its page. Any request to a host other than this machine is
// aborted and fails the test.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', viewport: { width: 1280, height: 800 } });

let account: OwnedAccount | null = null;
let external: string[] = [];

/** Signs in and lands on `to`, past the login page (whose own URL carries `to`). */
async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(account!.email);
  await page.locator('input[name="password"]').fill(account!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

/** A link's target as a prefetch asks for it: path and query, without Next's `_rsc` cache key. */
function target(href: string): string {
  const url = new URL(href, 'http://localhost');
  url.searchParams.delete('_rsc');
  return url.pathname + url.search;
}

/** Every route the page prefetches from now on, in order. */
function recordPrefetches(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['next-router-prefetch']) seen.push(target(request.url()));
  });
  return seen;
}

/** The targets of the page's internal links inside `selector`, or outside it when `invert` is set. */
const targets = (page: Page, selector: string, invert = false) =>
  page.locator('a[href^="/"]').evaluateAll((links, arg) => links
    .filter((a) => !!a.closest(arg.selector) !== arg.invert)
    .map((a) => a.getAttribute('href')!), { selector, invert })
    .then((hrefs) => [...new Set(hrefs.map(target))]);

/** Waits for the page to go quiet: no request in flight for half a second. */
async function quiet(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

const SHELL = 'aside, header, nav.fixed';

test.describe('the shell prefetches a link on intent, not on sight', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');

  test.beforeEach(async ({ context }) => {
    external = [];
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      external.push(hostname);
      return route.abort();
    });
    account = await createOwnedAccount(requireLocalOrigin(provider), serviceKey);
  });
  test.afterEach(async () => {
    try { await account?.dispose(); } finally { account = null; }
    expect(external, 'requests that left this machine').toEqual([]);
  });

  /** The sidebar's first link to a route nothing else on the page links to, and that has not been prefetched. */
  async function untouchedSidebarLink(page: Page, prefetched: string[]): Promise<{ link: Locator; route: string }> {
    const elsewhere = new Set(await targets(page, SHELL, true));
    const sidebar = page.locator('aside nav a[href^="/"]');
    for (const link of await sidebar.all()) {
      const route = target((await link.getAttribute('href'))!);
      if (route !== new URL(page.url()).pathname && !elsewhere.has(route) && !prefetched.includes(route)) return { link, route };
    }
    throw new Error('Every sidebar link is also on the page or already prefetched.');
  }

  test('a page load prefetches none of the routes only the shell links to', async ({ page }) => {
    const prefetched = recordPrefetches(page);
    await signIn(page, '/dashboard');
    await expect(page.locator('aside nav a[href^="/"]').first()).toBeVisible();
    await quiet(page);

    const shell = await targets(page, SHELL);
    const elsewhere = new Set(await targets(page, SHELL, true));
    const shellOnly = shell.filter((route) => !elsewhere.has(route));
    // A new household's sidebar links to some twenty routes (the rest are locked
    // behind its plan); a few of them are also linked from the page itself.
    expect(shellOnly.length).toBeGreaterThan(10);
    expect(prefetched.filter((route) => shellOnly.includes(route))).toEqual([]);
  });

  test('pointing at a sidebar link prefetches its route, and the link opens it', async ({ page }) => {
    const prefetched = recordPrefetches(page);
    await signIn(page, '/dashboard');
    await expect(page.locator('aside nav a[href^="/"]').first()).toBeVisible();
    await quiet(page);

    const { link, route } = await untouchedSidebarLink(page, prefetched);
    const prefetch = page.waitForRequest((request) => !!request.headers()['next-router-prefetch'] && target(request.url()) === route);
    await link.hover();
    await prefetch;

    await link.click();
    await page.waitForURL((url) => target(url.href) === route);
  });

  test('keyboard focus on a sidebar link prefetches its route', async ({ page }) => {
    const prefetched = recordPrefetches(page);
    await signIn(page, '/dashboard');
    await expect(page.locator('aside nav a[href^="/"]').first()).toBeVisible();
    await quiet(page);

    const { link, route } = await untouchedSidebarLink(page, prefetched);
    const prefetch = page.waitForRequest((request) => !!request.headers()['next-router-prefetch'] && target(request.url()) === route);
    await link.focus();
    await prefetch;
  });
});
