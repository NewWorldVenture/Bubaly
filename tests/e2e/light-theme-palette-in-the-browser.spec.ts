import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { closeWithoutSnapshot, createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// A11Y-001: the light theme's raw palette text, as the browser computes it.
//
// app/globals.css gives `text-<hue>-200/300/400` (and their hover, group-hover
// and slash forms) a darker shade in `.light`, outside marketing pages, `dark`
// subtrees and `.keep-dark-palette` presentations. The unit test holds the
// arithmetic; this holds the cascade: the real built CSS, the real pages.
//
// Part one needs no account: elements placed on the sign-in page (outside the
// marketing tree) in each situation the rule distinguishes. Part two signs in a
// disposable household and opens the two presentations that stay dark in the
// light theme, the wall display and Kitchen Mode, in their real states.
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

// Tailwind 3.4's shades, and the remap's. Each class here is one the app
// uses, so Tailwind has generated it.
const EMERALD_400 = 'rgb(52, 211, 153)';
const EMERALD_300 = 'rgb(110, 231, 183)';
const EMERALD_800 = 'rgb(6, 95, 70)';
const AMBER_200 = 'rgb(253, 230, 138)';
const AMBER_400 = 'rgb(251, 191, 36)';
const ROSE_300 = 'rgb(253, 164, 175)';
const ROSE_700 = 'rgb(190, 18, 60)';
const VIOLET_700 = 'rgb(109, 40, 217)';
const WHITE = 'rgb(255, 255, 255)';

const color = (page: Page, selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).color);

async function withTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => { try { localStorage.setItem('bubaly-theme', t); } catch { /* private mode */ } }, theme);
}

/** Every case on one page, outside the marketing tree. */
const FIXTURE = `
  <div id="fixture" style="padding:8px">
    <span id="base" class="text-emerald-400">base</span>
    <a id="hover-white" href="#" class="text-emerald-400 hover:text-white">hover:text-white wins on hover</a>
    <a id="hover-remap" href="#" class="text-white hover:text-emerald-300">hover:text-emerald-300</a>
    <a id="group" href="#" class="group"><span id="group-child" class="group-hover:text-violet-200">group-hover</span></a>
    <span id="slash" class="text-emerald-300/80">slash</span>
    <span id="self-marked" class="keep-dark-palette text-emerald-400">marked itself</span>
    <div class="keep-dark-palette"><span id="under-marked" class="text-emerald-400">under a marked ancestor</span></div>
    <div class="dark"><span id="under-dark" class="text-emerald-400">under dark</span></div>
    <div class="marketing-theme"><span id="under-marketing" class="text-emerald-400">under marketing-theme</span></div>
  </div>`;

async function openFixture(page: Page, theme: 'light' | 'dark') {
  await withTheme(page, theme);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  // After hydration, outside React's tree, so nothing re-renders it away.
  await expect(page.locator('input[name="email"]')).toBeEditable();
  await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), FIXTURE);
  await expect(page.locator('#fixture')).toBeAttached();
}

test.describe('the light theme’s palette remap, in the browser’s cascade', () => {
  test('applies to a base class, a hover form, a group-hover form and a slash form', async ({ page }) => {
    await openFixture(page, 'light');
    expect(await color(page, '#base')).toBe(EMERALD_800);
    expect(await color(page, '#slash')).toBe('rgba(6, 95, 70, 0.8)');
    expect(await color(page, '#hover-remap')).toBe(WHITE);
    await page.locator('#hover-remap').hover();
    expect(await color(page, '#hover-remap')).toBe(EMERALD_800);
    await page.locator('#group').hover();
    expect(await color(page, '#group-child')).toBe(VIOLET_700);
  });

  test('a more specific variant on the same element still wins: hover:text-white turns white', async ({ page }) => {
    await openFixture(page, 'light');
    expect(await color(page, '#hover-white')).toBe(EMERALD_800);
    await page.locator('#hover-white').hover();
    expect(await color(page, '#hover-white')).toBe(WHITE);
  });

  test('leaves a marked element, anything under a marked, dark or marketing ancestor, as drawn', async ({ page }) => {
    await openFixture(page, 'light');
    expect(await color(page, '#self-marked')).toBe(EMERALD_400);
    expect(await color(page, '#under-marked')).toBe(EMERALD_400);
    expect(await color(page, '#under-dark')).toBe(EMERALD_400);
    expect(await color(page, '#under-marketing')).toBe(EMERALD_400);
  });

  test('changes nothing in the dark theme', async ({ page }) => {
    await openFixture(page, 'dark');
    expect(await color(page, '#base')).toBe(EMERALD_400);
    await page.locator('#hover-remap').hover();
    expect(await color(page, '#hover-remap')).toBe(EMERALD_300);
  });
});

test.describe('presentations that stay dark in the light theme keep their shades', () => {
  test.skip(process.env.E2E_AUTHENTICATED !== '1', 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');
  test.describe.configure({ timeout: 90_000 });

  let account: OwnedAccount | null = null;

  test.beforeEach(async ({ page }) => {
    account = await createOwnedAccount(requireLocalOrigin(provider), serviceKey);
    const admin = createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.from('subscriptions')
      .upsert({ family_id: account.familyId, plan: 'plus', status: 'active' }, { onConflict: 'family_id' });
    if (error) throw new Error(`Could not give the household a Plus plan (${error.code ?? 'no code'}).`);
    await withTheme(page, 'light');
    await page.goto('/login?redirect=%2Fdashboard%2Fmedications', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/dashboard/medications', { timeout: 60_000 });
  });

  test.afterEach(async ({ context }) => {
    // Pages close before the context, and before Playwright's failure
    // snapshot, so a failure cannot attach the sign-in form's values to it.
    try { await closeWithoutSnapshot(context); } finally {
      try { await account?.dispose(); } finally { account = null; }
    }
  });

  test('an ordinary app page is remapped (control)', async ({ page }) => {
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    const taken = page.locator('span.text-emerald-400', { hasText: /taken/ });
    await expect(taken).toBeVisible();
    expect(await taken.evaluate((el) => getComputedStyle(el).color)).toBe(EMERALD_800);
  });

  test('the wall display: its edit-mode delete control and its status line keep the original shades', async ({ page }) => {
    await page.goto('/display');
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    const root = page.locator('.keep-dark-palette').first();
    await expect(root).toBeVisible();
    // Edit mode, as a person opens it. The header drifts (the screensaver), so
    // it never holds still long enough for an actionability check.
    await page.getByTitle('Edit display').dispatchEvent('click');
    const remove = page.getByRole('button', { name: 'Delete' }).first();
    await expect(remove).toBeVisible();
    expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(ROSE_300);
    // Control: without the boundary (as at 120ec8e) the remap reaches it. A
    // handle, not the locator, which would stop matching once the class goes.
    const boundary = await root.elementHandle();
    await boundary!.evaluate((el) => el.classList.remove('keep-dark-palette'));
    expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(ROSE_700);
    await boundary!.evaluate((el) => el.classList.add('keep-dark-palette'));
    expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(ROSE_300);
    // The status line (timezone fallback, unavailable data) cannot be produced
    // with real data any more: 0449 holds families.timezone to a real zone. The
    // same element is placed where the display renders it, after the header
    // inside the display's own root.
    await root.locator('header').first().evaluate((header) => header.insertAdjacentHTML('afterend',
      '<p id="status-probe" role="status" class="mt-3 text-xs text-amber-200">Family timezone is unavailable.</p>'));
    expect(await color(page, '#status-probe')).toBe(AMBER_200);
  });

  test('Kitchen Mode keeps the original shades', async ({ page }) => {
    // A reminder due now: Kitchen Mode shows it as an amber chip.
    const admin = createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const seeded = await admin.from('reminders').insert({ family_id: account!.familyId, title: 'Probe reminder', remind_at: new Date().toISOString() });
    if (seeded.error) throw new Error(`Could not seed a reminder (${seeded.error.code ?? 'no code'}).`);
    await page.goto('/dashboard/briefing');
    await page.getByRole('button', { name: 'Kitchen Mode' }).or(page.getByRole('tab', { name: 'Kitchen Mode' })).first().click();
    const kitchen = page.locator('.keep-dark-palette.fixed');
    await expect(kitchen).toBeVisible();
    await expect(kitchen.getByText('Probe reminder')).toBeVisible();
    // Every remappable class inside it renders its own original shade.
    const ORIGINAL: Record<string, string> = {
      'text-amber-200': AMBER_200, 'text-amber-300': 'rgb(252, 211, 77)', 'text-amber-400': AMBER_400,
      'text-amber-500': 'rgb(245, 158, 11)', 'text-amber-600': 'rgb(217, 119, 6)',
      'text-emerald-200': 'rgb(167, 243, 208)', 'text-emerald-300': EMERALD_300, 'text-emerald-400': EMERALD_400,
      'text-emerald-500': 'rgb(16, 185, 129)', 'text-emerald-600': 'rgb(5, 150, 105)',
    };
    const rendered = await kitchen.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('*'))
      .flatMap((el) => Array.from(el.classList).filter((c) => /^text-(amber|emerald)-(200|300|400|500|600)$/.test(c))
        .map((cls) => ({ cls, color: getComputedStyle(el).color }))));
    expect(rendered.length, 'remappable palette text inside Kitchen Mode').toBeGreaterThan(0);
    // The due reminder's "Don't forget" heading is a 600: the boundary holds for those too.
    expect(rendered.map((r) => r.cls)).toContain('text-amber-600');
    for (const { cls, color: shade } of rendered) expect(shade, cls).toBe(ORIGINAL[cls]);
  });
});
