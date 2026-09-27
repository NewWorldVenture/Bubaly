import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { expect, test as base, type Browser, type BrowserContext } from '@playwright/test';
import { createOwnedAccount, type OwnedAccount } from './helpers/durable-session';

// Every page in the app, opened by a signed-in parent who is also a super
// admin, against the disposable Supabase this job starts.
//
// The public crawl of www.bubaly.com can only see a signed-in page's front
// door (a redirect to /login). This is the other side of that door: each
// route in app/**/page.tsx — discovered from the filesystem, so a new page is
// in this sweep the day it is added — must answer without a server error or
// an unexpected 404, render without an uncaught error, a console error, a raw
// catalogue key or a doubled brand in its title, and fit a desktop viewport.
//
// A dynamic segment gets an id that matches nothing. What that tests is the
// page's not-found path, which is the one a stale link or a deleted record
// takes: it must be a 404 or an empty state, never a crash.

const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

type Route = { path: string; dynamic: boolean };

/** app/**\/page.tsx as the URL a browser would open. */
function everyRoute(): Route[] {
  const root = join(process.cwd(), 'app');
  const out: Route[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === 'page.tsx') {
        const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
        const dynamic = segments.some((s) => s.startsWith('['));
        const path = '/' + segments.map((s) => {
          const param = /^\[(.+)\]$/.exec(s)?.[1];
          if (!param) return s;
          if (param === 'provider') return 'google';
          return /id$/i.test(param) ? NO_SUCH_ID : 'no-such-page';
        }).join('/');
        out.push({ path: path === '/' ? '/' : path.replace(/\/$/, ''), dynamic });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Pages whose answer to a signed-in visit is, by design, a 404: each is named
// with the reason, so the list cannot quietly grow into an exemption.
const EXPECTED_404 = new Map<string, string>([
  ['/resources/benchmarks', 'exists only while the admin publication flag is on; this database has it off'],
]);

// For a local run against a stack started without some service (realtime is
// the usual one to leave out on a small disk): a regex of console errors to
// set aside, named on the command line so it is never silent. CI sets nothing.
const IGNORED_CONSOLE = process.env.E2E_SWEEP_IGNORE_CONSOLE ? new RegExp(process.env.E2E_SWEEP_IGNORE_CONSOLE) : null;

const CATALOGUE_KEY = /\b[a-z][a-zA-Z0-9]*\.[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/;
// Any title whose own part ends in the brand before the template adds it:
// "X · Bubaly · Bubaly", and also "Welcome to Bubaly · Bubaly".
const DOUBLED_BRAND = /(?:^|[\s·|—–:-])Bubaly\s*·\s*Bubaly\s*$/i;

type Session = { account: OwnedAccount; state: Awaited<ReturnType<BrowserContext['storageState']>> };

const test = base.extend<object, { session: Session }>({
  session: [async ({ browser }: { browser: Browser }, use: (s: Session) => Promise<void>, workerInfo) => {
    const account = await createOwnedAccount(provider, serviceKey);
    const admin = createClient(provider, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    // Admin pages are part of "every page". A row in the disposable database's
    // super_admins is what makes this fixture one; it is removed with it.
    const grant = await admin.from('super_admins').insert({ email: account.email.toLowerCase() });
    if (grant.error) throw new Error('Sweep fixture could not be made a super admin.');
    const origin = workerInfo.project.use.baseURL as string;
    const context = await browser.newContext({ baseURL: origin });
    try {
      const page = await context.newPage();
      await page.goto('/login?redirect=/home', { waitUntil: 'domcontentloaded' });
      await page.locator('input[name="email"]').fill(account.email);
      await page.locator('input[name="password"]').fill(account.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
      const state = await context.storageState();
      await context.close();
      await use({ account, state });
    } finally {
      await context.close().catch(() => {});
      await admin.from('super_admins').delete().eq('email', account.email.toLowerCase());
      await account.dispose();
    }
  }, { scope: 'worker' }],
});

test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

test.describe('every page, signed in', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the isolated Supabase.');

  const routes = everyRoute();

  test('the sweep found the app', () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.some((r) => r.path === '/dashboard')).toBe(true);
    expect(routes.some((r) => r.path.startsWith('/admin/'))).toBe(true);
  });

  // Each test opens its own context from the stored session, so a page that
  // signs its own browser out (/auth/signout/complete with a bridge cookie)
  // cannot sign out the rest of the sweep.
  for (const route of routes) {
    test(`${route.path}`, async ({ browser, session }, testInfo) => {
      const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: session.state });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e).slice(0, 300)));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
      try {
        const response = await page.goto(route.path, { waitUntil: 'load', timeout: 45_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        const status = response?.status() ?? 0;
        const notFoundOk = route.dynamic || EXPECTED_404.has(route.path);

        expect(status, `${route.path} answered ${status}`).toBeLessThan(500);
        if (!notFoundOk) expect(status, `${route.path} is a page in app/, and answered 404`).not.toBe(404);

        // The document's own 404 is reported to the console as a failed
        // resource; that is the status asserted above, not a second finding.
        const errors = consoleErrors
          .filter((text) => !(status === 404 && notFoundOk && /status of 404/.test(text)))
          .filter((text) => !IGNORED_CONSOLE?.test(text));
        expect(pageErrors, 'uncaught errors').toEqual([]);
        expect(errors, 'console errors').toEqual([]);

        const facts = await page.evaluate(() => ({
          title: document.title,
          text: document.body?.innerText ?? '',
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        }));
        expect(facts.title, 'title').not.toMatch(DOUBLED_BRAND);
        expect(facts.text.match(CATALOGUE_KEY)?.[0] ?? null, 'a raw catalogue key on the page').toBeNull();
        expect(facts.overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    });
  }
});
