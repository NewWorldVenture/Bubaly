import { test, expect } from '@playwright/test';

// Public marketing + auth routes must render without a database or session.
const PUBLIC_ROUTES = [
  '/', '/pricing', '/features', '/how-it-works', '/security',
  '/faq', '/ai', '/mobile', '/blog', '/contact', '/login', '/signup',
];

test.describe('public routes render', () => {
  for (const path of PUBLIC_ROUTES) {
    test(`GET ${path} → 200 with content`, async ({ page }) => {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(res, `no response for ${path}`).toBeTruthy();
      expect(res!.status(), `bad status for ${path}`).toBeLessThan(400);
      // Page has a visible heading (proves it rendered, not a blank error).
      await expect(page.locator('h1, h2').first()).toBeVisible();
    });
  }
});

test('homepage shows primary CTA and the theme toggle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible();
  // Task 3: dark/light toggle is present on the homepage.
  await expect(page.getByRole('button', { name: /switch to (light|dark) mode/i })).toBeVisible();
});

test('pricing shows the billing period toggle', async ({ page }) => {
  await page.goto('/pricing');
  await expect(page.getByRole('button', { name: /^monthly$/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^yearly$/i })).toBeVisible();
});

test('protected dashboard redirects anonymous users to login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
