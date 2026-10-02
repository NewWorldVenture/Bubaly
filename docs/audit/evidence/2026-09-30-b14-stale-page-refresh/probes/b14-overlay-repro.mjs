// Minimal keyboard reproduction for one overlay: focus the trigger by its
// accessible name, open it with Enter, record where focus goes, press Escape,
// and record where focus lands, compared by accessible name so a re-rendered
// trigger still counts as the trigger.
// Usage: node b14-overlay-repro.mjs <base> <path> <state.json> <width> <triggerName> [--arrows]
import { chromium } from 'playwright';
const [base, path, state, width, triggerName, arrows] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM || undefined });
const context = await browser.newContext({ storageState: state, viewport: { width: Number(width), height: 900 } });
const page = await context.newPage();
await page.goto(base + path, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
const describe = () => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: 'BODY' };
  return { tag: el.tagName, role: el.getAttribute('role'), name: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), inDialog: !!el.closest('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]') };
});
const trigger = page.getByRole('button', { name: triggerName, exact: true }).first();
await trigger.focus();
const before = await describe();
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const overlay = page.locator('[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]').filter({ visible: true }).last();
const opened = { role: await overlay.getAttribute('role').catch(() => null), modal: await overlay.getAttribute('aria-modal').catch(() => null) };
const afterOpen = await describe();
let arrowResult = null;
if (arrows) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); arrowResult = await describe(); }
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const afterEscape = await describe();
const closed = !(await overlay.isVisible().catch(() => false));
console.log(JSON.stringify({ path, width: Number(width), trigger: triggerName, before, opened, afterOpen, arrowResult, closed, afterEscape, focusReturnedToTrigger: afterEscape.name === before.name && afterEscape.tag === before.tag }));
await browser.close();
