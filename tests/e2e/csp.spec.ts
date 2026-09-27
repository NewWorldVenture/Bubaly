import { test, expect, type Page } from '@playwright/test';
import { PUBLIC_ROUTES } from './public-routes';


async function expectCspSafeRender(page: Page, path: string) {
  const violations: string[] = [];
  const recordViolation = (msg: { text(): string }) => {
    if (/content security policy/i.test(msg.text())) violations.push(msg.text());
  };
  page.on('console', recordViolation);
  try {
    // Initial document resources must load; unrelated fetches and Next link
    // prefetches need not become idle before a rendered page can be checked.
    await page.goto(path, { waitUntil: 'load' });
    await expect(page.locator('h1, h2').first()).toBeVisible();
    expect(violations, violations.join('\n')).toEqual([]);
  } finally {
    page.off('console', recordViolation);
  }
}

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
      await expectCspSafeRender(page, path);
    });
  }
});

// These controls use real Chromium navigation and enforced CSP headers. Only
// document/resource transport is synthetic; no app server or provider is used.
test.describe('CSP readiness boundary', () => {
  test('checks a rendered page while an unrelated fetch remains pending', async ({ page }) => {
    page.setDefaultNavigationTimeout(1_500);
    let pending = 0;
    let settled = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('https://csp-readiness.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/background') {
        pending += 1;
        await held;
        settled += 1;
        await route.fulfill({ status: 200, body: 'done' });
      } else if (pathname === '/ready.js') {
        await route.fulfill({ contentType: 'application/javascript', body: "void fetch('/background'); document.documentElement.dataset.ready = 'yes';" });
      } else {
        await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'" }, body: '<!doctype html><h1>Ready</h1><script src="/ready.js" defer></script>' });
      }
    });
    try {
      await expectCspSafeRender(page, 'https://csp-readiness.test/ready');
      await expect(page.locator('html')).toHaveAttribute('data-ready', 'yes');
      expect(pending).toBe(1);
      expect(settled).toBe(0);
    } finally {
      release();
    }
  });

  test('still rejects an actual browser-enforced CSP violation', async ({ page }) => {
    let forbiddenRequests = 0;
    await page.route('https://csp-readiness.test/**', async route => {
      if (new URL(route.request().url()).pathname === '/forbidden.js') {
        forbiddenRequests += 1;
        await route.fulfill({ contentType: 'application/javascript', body: 'window.forbiddenExecuted = true;' });
      } else {
        await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'none'" }, body: '<!doctype html><h1>Ready</h1><script src="/forbidden.js"></script>' });
      }
    });
    await expect(expectCspSafeRender(page, 'https://csp-readiness.test/blocked')).rejects.toThrow(/content security policy/i);
    await expect(page.locator('h1')).toHaveText('Ready');
    expect(forbiddenRequests).toBe(0);
  });
});
