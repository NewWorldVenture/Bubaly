// Signs each persona in through the real /login and /kid-login forms of the
// local production build and saves a Playwright storage state (local only,
// never committed). Usage: node b14-signin.mjs <creds.json> <outDir> <base>
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const [credsFile, outDir, base] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM || undefined });
console.log(JSON.stringify({ browser: browser.version() }));
for (const role of ['parent', 'admin', 'child']) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (role === 'child') {
    await page.goto(`${base}/kid-login`);
    await page.locator('input[name="username"]').fill(creds.child.username);
    await page.locator('input[name="pin"]').fill(creds.child.pin);
  } else {
    await page.goto(`${base}/login`);
    await page.locator('input[name="email"]').fill(creds[role].email);
    await page.locator('input[name="password"]').fill(creds[role].password);
  }
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !/\/(kid-)?login/.test(url.pathname), { timeout: 30_000 }).catch(() => {});
  const landed = new URL(page.url()).pathname;
  await context.storageState({ path: `${outDir}/${role}-state.json` });
  console.log(JSON.stringify({ role, landed }));
  await context.close();
}
await browser.close();
