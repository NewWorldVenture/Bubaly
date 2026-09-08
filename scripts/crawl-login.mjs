// scripts/crawl-login.mjs
//
// Signs in through the real login form once and writes the resulting cookies to
// a file, for scripts/crawl-authenticated-routes.mjs to reuse.
//
// The sign-in goes through the browser rather than straight to GoTrue on
// purpose: the session cookie's name, chunking and encoding are whatever
// @supabase/ssr actually writes. Hand-rolling that format means the crawl can
// fail for a reason that has nothing to do with the pages under test.
//
//   BASE_URL=http://127.0.0.1:3000 TEST_EMAIL=… TEST_PASSWORD=… \
//   node scripts/crawl-login.mjs cookies.json

import { chromium } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const out = process.argv[2] ?? 'cookies.json';
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;

if (!email || !password) {
  console.error('TEST_EMAIL and TEST_PASSWORD are required.');
  process.exit(1);
}

// The sandbox ships one Chromium at a fixed path. When the pinned Playwright
// wants a different revision, point it at the installed binary rather than
// downloading a second copy.
const executablePath = process.env.CHROMIUM_PATH
  || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(
  executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
);
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('  [browser console]', message.text().slice(0, 300));
  });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  // The redirect off /login lands before the session cookie is necessarily
  // committed; give the client a beat to persist it.
  await page.waitForTimeout(3000);

  const cookies = await context.cookies();
  const landed = page.url();
  if (!cookies.some((cookie) => cookie.name.includes('auth-token'))) {
    console.error(`sign-in did not produce a session cookie. Landed on ${landed}.`);
    console.error(`cookies seen: ${cookies.map((c) => c.name).join(', ') || '(none)'}`);
    process.exit(1);
  }

  writeFileSync(out, JSON.stringify(cookies, null, 2));
  console.log(`signed in as ${email}; landed on ${landed}`);
  console.log(`wrote ${cookies.length} cookie(s) to ${out}`);
} finally {
  await browser.close();
}
