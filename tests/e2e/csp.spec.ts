import { test, expect } from '@playwright/test';
import { PUBLIC_ROUTES } from './public-routes';

// Hardening: every response carries an enforced Content-Security-Policy, and no
// public page trips it (a violation surfaces as a "Refused to ..." console error
// mentioning "Content Security Policy" in Chromium).
test.describe('Content-Security-Policy', () => {
  test('header is enforced with strict object/base/frame-ancestors directives', async ({ request }) => {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'missing Content-Security-Policy header').toBeTruthy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers()['content-security-policy-report-only']).toBeUndefined();
  });

  test('the public blog may be framed by the app (same-origin only)', async ({ request }) => {
    const res = await request.get('/blog');
    expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers()['x-frame-options']).toBe('SAMEORIGIN');
  });

  for (const path of PUBLIC_ROUTES) {
    test(`no CSP violations while rendering ${path}`, async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (msg) => {
        if (/content security policy/i.test(msg.text())) violations.push(msg.text());
      });
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page.locator('h1, h2').first()).toBeVisible();
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
});
