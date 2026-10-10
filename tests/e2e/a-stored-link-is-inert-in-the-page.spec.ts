import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { closeWithoutSnapshot, createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// SEC-006: a link a family member stored is rendered only as a web link.
//
// Four surfaces rendered a stored link straight into href: a warranty's claim
// link, a favorite's link, a trip document's file link and a library item's
// page link. The source guard (tests/a-stored-link-is-a-web-link.test.ts)
// listed link fields by name and none of these names was on its list. A
// member could store `javascript:…` in any of them (the favorite and trip
// document forms write it as typed, from the browser), and the page handed it
// to whoever opened the link.
//
// Measured on main (36a516d, React 19, Chromium): React replaced each
// `javascript:` href with `javascript:throw new Error('React has blocked a
// javascript: URL…')`, and rendered the `data:text/html,<script>…` href as
// stored. Clicking them opened two about:blank tabs and nothing else: no
// dialog, no script in the app's origin (Chromium refuses a top-level data:
// navigation). So this was the rule's coverage, not a demonstrated script; the
// check below is the rule — no stored value becomes a non-web href at all.
//
// Real pages on the disposable local stack, a disposable household. The rows
// are seeded with the service role: that is the stored state, however it got
// there (the favorites case below also stores it through the real form). Any
// request to a host other than this machine is aborted and fails the test.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const HOSTILE = ['javascript:alert(document.domain)', ' JavaScript:alert(document.domain)', 'data:text/html,<script>alert(document.domain)</script>'];
const SAFE = 'https://example.com/claim';

let account: OwnedAccount | null = null;
let external: string[] = [];
let dialogs: string[] = [];

const admin = () => createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(account!.email);
  await page.locator('input[name="password"]').fill(account!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

/** Every href on the page whose scheme is not a web, mail or phone link. */
const activeContentHrefs = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('a[href], area[href]'))
  .map((a) => a.getAttribute('href') ?? '')
  .filter((href) => {
    try {
      return !['http:', 'https:', 'mailto:', 'tel:', 'sms:'].includes(new URL(href, location.href).protocol);
    } catch {
      return false;
    }
  }));

/** Watch every page of the context for a dialog (what the stored script would open). */
function watchDialogs(context: BrowserContext) {
  const watch = (p: Page) => p.on('dialog', (d) => { dialogs.push(`${p.url()} ${d.message()}`); void d.dismiss(); });
  context.pages().forEach(watch);
  context.on('page', watch);
}

async function insert(table: string, rows: Record<string, unknown>[]) {
  const { error } = await admin().from(table).insert(rows as never);
  if (error) throw new Error(`Could not seed ${table} (${error.code ?? error.message}).`);
}

/** The surface's rows: one per hostile spelling, then one safe control. */
const named = (prefix: string) => [...HOSTILE.map((_, i) => `${prefix} hostile ${i + 1}`), `${prefix} safe`];

test.describe('SEC-006: a stored link is rendered only as a web link', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ context }) => {
    external = [];
    dialogs = [];
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      external.push(hostname);
      return route.abort();
    });
    watchDialogs(context);
    account = await createOwnedAccount(requireLocalOrigin(provider), serviceKey);
    // Warranties and trips are plan-level pages.
    const { error } = await admin().from('subscriptions')
      .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' });
    if (error) throw new Error(`Could not give the household a Plus plan (${error.code ?? 'no code'}).`);
  });

  test.afterEach(async ({ context }) => {
    // Pages close before the context, and before Playwright's failure
    // snapshot, so a failure cannot attach the sign-in form's values to it
    // (the established pattern; CI's artifact upload also excludes this suite).
    try { await closeWithoutSnapshot(context); } finally {
      try { await account?.dispose(); } finally { account = null; }
    }
    expect(external, 'requests that left this machine').toEqual([]);
    expect(dialogs, 'a stored link ran script').toEqual([]);
  });

  /**
   * Opens `to`, then: no active-content href anywhere, the safe link is a
   * link, and each hostile row's link, clicked, runs nothing and opens
   * nothing. The href check is soft, so where it fails (main) the clicks are
   * still made and their outcome reported beside it.
   */
  async function expectInert(page: Page, to: string, safeLink: () => ReturnType<Page['locator']>, hostileClickTargets: () => ReturnType<Page['locator']>) {
    await signIn(page, to);
    await expect(safeLink()).toHaveAttribute('href', SAFE);
    expect.soft(await activeContentHrefs(page), 'non-web hrefs on the page').toEqual([]);
    const targets = hostileClickTargets();
    expect(await targets.count(), 'one rendered (inert) link per hostile row').toBe(HOSTILE.length);
    for (let i = 0; i < HOSTILE.length; i += 1) await targets.nth(i).click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    expect(page.url()).toContain(to);
    expect(page.context().pages(), 'no tab was opened').toHaveLength(1);
  }

  test('a warranty’s claim link', async ({ page }) => {
    const names = named('Fridge');
    await insert('home_warranties', [...HOSTILE, SAFE].map((claim_url, i) => ({ family_id: account!.familyId, name: names[i], claim_url })));
    const row = (name: string) => page.locator('div', { has: page.getByText(name, { exact: true }) }).filter({ hasText: 'File claim' }).last();
    await expectInert(page, '/dashboard/home/warranties',
      () => row(names[3]).getByText('File claim').locator('xpath=ancestor-or-self::a[1]'),
      () => page.locator('a:not([href^="http"])', { hasText: 'File claim' }));
  });

  test('a favorite’s link, stored through the real form and seeded', async ({ page }) => {
    const names = named('Pasta');
    await insert('family_favorites', [...HOSTILE, SAFE].map((ref_url, i) => ({ family_id: account!.familyId, name: names[i], kind: 'recipe', ref_url })));
    await expectInert(page, '/dashboard/favorites',
      () => page.locator('div', { hasText: names[3] }).getByText('Open').locator('xpath=ancestor-or-self::a[1]').last(),
      () => page.locator('a:not([href^="http"])', { hasText: /^\s*Open\s*$/ }));
    // And as a member types it: the form saves it, and it is still inert.
    await page.getByRole('button', { name: 'Add favorite' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add favorite' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Typed favorite');
    await dialog.getByRole('textbox', { name: /^Link/ }).fill(HOSTILE[0]);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await admin().from('family_favorites').select('ref_url')
      .eq('family_id', account!.familyId).eq('name', 'Typed favorite')).data, { message: 'the form stored the link as typed' })
      .toEqual([{ ref_url: HOSTILE[0] }]);
    await page.reload();
    await expect(page.getByText('Typed favorite')).toBeVisible();
    expect(await activeContentHrefs(page)).toEqual([]);
  });

  test('a trip document’s file link', async ({ page }) => {
    const { data: trip, error } = await admin().from('vacations').insert({ family_id: account!.familyId, title: 'Probe trip' }).select('id').single();
    if (error || !trip) throw new Error(`Could not seed a trip (${error?.code ?? 'no row'}).`);
    const names = named('Passport');
    await insert('vacation_documents', [...HOSTILE, SAFE].map((file_url, i) => ({ family_id: account!.familyId, vacation_id: trip.id, title: names[i], file_url })));
    await expectInert(page, `/dashboard/vacations/${trip.id}/documents`,
      () => page.locator('div', { hasText: names[3] }).getByText('Open file ↗').locator('xpath=ancestor-or-self::a[1]').last(),
      () => page.locator('a:not([href^="http"])', { hasText: 'Open file ↗' }));
  });

  test('a library item’s page link', async ({ page }) => {
    const names = named('Episode');
    await insert('library_items', [...HOSTILE, SAFE].map((page_url, i) => ({
      family_id: account!.familyId, guid: `probe-${i}`, kind: 'episode', title: names[i], page_url,
      published_at: new Date(Date.UTC(2026, 0, 10 - i)).toISOString(),
    })));
    await expectInert(page, '/dashboard/library',
      () => page.locator(`a[aria-label="Open page"][href="${SAFE}"]`),
      () => page.locator('a[aria-label="Open page"]:not([href^="http"])'));
  });
});
