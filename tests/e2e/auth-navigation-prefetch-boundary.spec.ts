import { expect, test, type Page } from '@playwright/test';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const errors = new WeakMap<Page, string[]>();
const requests = new WeakMap<Page, { url: string; method: string; headers: Record<string, string> }[]>();
test.beforeEach(({ page }) => {
  const failures: string[] = [];
  const reads: { url: string; method: string; headers: Record<string, string> }[] = [];
  errors.set(page, failures);
  requests.set(page, reads);
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') failures.push('console ' + m.type() + ': ' + m.text()); });
  page.on('pageerror', e => failures.push('page error: ' + e.message));
  page.on('requestfailed', r => failures.push('request failed: ' + r.url() + ': ' + r.failure()?.errorText));
  page.on('response', r => { if (r.status() >= 400) failures.push('HTTP ' + r.status() + ': ' + r.url()); });
  page.on('request', r => reads.push({ url: r.url(), method: r.method(), headers: r.headers() }));
});
test.afterEach(({ page }) => {
  expect(errors.get(page), 'every browser error collector is installed').toBeDefined();
  expect(errors.get(page), 'auth navigation has no console, page, request or HTTP failures').toEqual([]);
});

async function open(page: Page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('input[name="email"]')).toBeEditable();
}

test('auth links preserve destinations without speculative viewport, hover or keyboard RSC reads', async ({ page }) => {
  await open(page);
  const links = page.locator('a[href="/"], a[href="/terms"], a[href="/acceptable-use"], a[href="/privacy"], a[href="/signup"], a[href="/kid-login"], a[href="/login?reset=1"]');
  expect((await links.evaluateAll(nodes => nodes.map(n => n.getAttribute('href')))).sort()).toEqual(['/', '/', '/acceptable-use', '/kid-login', '/login?reset=1', '/privacy', '/signup', '/terms'].sort());
  for (let i = 0; i < await links.count(); i++) {
    await links.nth(i).hover();
    await links.nth(i).focus();
    await expect(links.nth(i)).toBeFocused();
  }
  // Long enough for the actual Next Link viewport/intent scheduler to run.
  await page.waitForTimeout(1_000);
  expect(requests.get(page)?.filter(r => r.headers.rsc === '1' || r.headers['next-router-prefetch'] === '1' || new URL(r.url).searchParams.has('_rsc')), 'no server page is speculatively read').toEqual([]);
});

test('keyboard activation still opens password recovery explicitly', async ({ page }) => {
  await open(page);
  const link = page.locator('a[href="/login?reset=1"]');
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await expect(page.locator('input[name="email"]')).toBeEditable();
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
});

test('an explicit click still opens the child sign-in form', async ({ page }) => {
  await open(page);
  await page.locator('a[href="/kid-login"]').click();
  await expect(page).toHaveURL(/\/kid-login$/);
  await expect(page.locator('input[name="username"]')).toBeEditable();
  await expect(page.locator('input[name="pin"]')).toBeEditable();
  await page.waitForLoadState('networkidle');
});

test('an explicit click still opens the account creation form', async ({ page }) => {
  await open(page);
  await page.locator('a[href="/signup"]').click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await expect(page.locator('input[name="email"]')).toBeEditable();
  await expect(page.locator('input[name="password"]')).toBeEditable();
  await page.waitForLoadState('networkidle');
});
