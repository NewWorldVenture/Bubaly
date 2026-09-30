// Integrated retest for MAIN-F22: a kid-login username is matched exactly, not as
// a LIKE pattern. The real PIN with a pattern that would match the real username
// must not sign in; the real username with the same PIN must.
import { chromium } from '/home/user/Bubaly/node_modules/playwright/index.mjs';
const BASE = 'http://127.0.0.1:3107';
const [user, pin] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM });
const tries = (process.env.TRIES ?? 'maya%,mayarive_a,%').split(',').concat([user]);
const out = [];
for (const u of tries) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/kid-login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', u);
  await page.fill('input[name="pin"]', pin);
  const clientBlocked = await page.locator('button[type="submit"]').isDisabled();
  // A hostile client: drop the form's own constraints and submit anyway.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('input')) { el.removeAttribute('pattern'); el.removeAttribute('maxlength'); el.removeAttribute('minlength'); }
    const f = document.querySelector('form'); if (f) f.noValidate = true;
    const b = document.querySelector('button[type="submit"]'); if (b) b.disabled = false;
  });
  await Promise.all([
    page.waitForURL((x) => !x.pathname.startsWith('/kid-login'), { timeout: 12_000 }).catch(() => {}),
    page.click('button[type="submit"]', { force: true, timeout: 5_000 }).catch(() => {}),
  ]);
  await page.waitForTimeout(1500);
  const cookies = await ctx.cookies();
  const names = cookies.filter((c) => c.name.includes('auth')).map((c) => c.name + ':' + c.value.length);
  const home = await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const homeLanded = new URL(page.url()).pathname;
  const alert = (await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(' | ').slice(0, 120);
  out.push({ username: u, clientBlocked, landed: new URL(page.url()).pathname, signedIn: cookies.some((c) => c.name.includes('auth-token')), names, homeLanded, alert });
  await ctx.close();
}
await browser.close();
for (const o of out) console.log(JSON.stringify(o));
