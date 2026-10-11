import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cn } from '../../lib/utils/cn';

// A11Y-001: a status chip on a row that has its own status tint, as the
// browser computes it.
//
// A snoozed reminder's row is bg-warning/5 and an overdue one's bg-danger/5;
// each carries Badges (bg-<role>/15 text-<role>) for its priority and its
// state, so the chip's ground is two translucent tints over the page. The unit
// contract (tests/brand-contrast-contract.test.ts) holds the arithmetic; this
// holds what the built CSS renders. The row and the Badges are built from the
// components' own class strings, read from the source and merged with the same
// cn() the row uses, and placed on the sign-in page (no account needed) over
// each page ground. Each Badge's background is composed from the computed
// background of every ancestor up to the first opaque one.
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const reminders = readFileSync('components/modules/reminders-module.tsx', 'utf8');
const badgeSource = readFileSync('components/ui/badge.tsx', 'utf8');

function sourceString(source: string, pattern: RegExp, what: string): string {
  const m = source.match(pattern);
  if (!m) throw new Error(`${what} not found in the source`);
  return m[1];
}

// The row's cn(): its base, the overdue-or-ordinary branch, then the snoozed state.
const ROW_BASE = sourceString(reminders, /<div key=\{reminder\.id\}\s+className=\{cn\(\s+'([^']+)'/, 'the reminder row');
const ROW_OVERDUE = sourceString(reminders, /overdue && !completed \? '([^']+)'/, 'the overdue row');
const ROW_ORDINARY = sourceString(reminders, /overdue && !completed \? '[^']+' : '([^']+)'/, 'the ordinary row');
const ROW_SNOOZED = sourceString(reminders, /snoozed && '([^']+)',\s+\)\}>/, 'the snoozed row');
const BADGE_BASE = sourceString(badgeSource, /'(inline-flex [^']+)'/, "Badge's base classes");
const tone = (role: string) => sourceString(badgeSource, new RegExp(`${role}: '([^']+)'`), `Badge's ${role} tone`);

const rowClass = (state: 'snoozed' | 'overdue') =>
  cn(ROW_BASE, state === 'overdue' ? ROW_OVERDUE : ROW_ORDINARY, state === 'snoozed' && ROW_SNOOZED);
const badge = (role: string, label: string) => `<span data-chip="${role}" class="${cn(BADGE_BASE, tone(role))}">${label}</span>`;

// What each row shows: its priority's Badge (medium is warning, high and
// urgent are danger) and its state's.
const ROW = (state: 'snoozed' | 'overdue') => `
  <div data-row="${state}" class="${rowClass(state)}">
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm font-semibold">Probe reminder</p>
      ${badge('warning', 'Medium')}${badge('danger', 'High')}
      ${state === 'snoozed' ? badge('warning', 'Snoozed') : badge('danger', 'Overdue')}
    </div>
  </div>`;

const FIXTURE = `
  <div id="fixture">
    ${['bg-bg', 'bg-surface', 'bg-elevated'].map((ground) => `
      <div data-ground="${ground}" class="${ground} space-y-3 p-4">${ROW('snoozed')}${ROW('overdue')}</div>`).join('')}
  </div>`;

async function openFixture(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => { try { localStorage.setItem('bubaly-theme', t); } catch { /* private mode */ } }, theme);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  // After hydration, outside React's tree, so nothing re-renders it away.
  await expect(page.locator('input[name="email"]')).toBeEditable();
  await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), FIXTURE);
  await expect(page.locator('#fixture')).toBeAttached();
}

type Reading = { ground: string; row: string; chip: string; text: string; layers: number; ratio: number };

/** Each chip's text against its composed background. */
function measure(page: Page): Promise<Reading[]> {
  return page.locator('#fixture').evaluate((root) => {
    const parse = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number);
      return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
    };
    const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return Array.from(root.querySelectorAll<HTMLElement>('[data-chip]')).map((chip) => {
      // Translucent backgrounds from the chip outward, until an opaque one.
      const stack: { rgb: number[]; a: number }[] = [];
      for (let el: HTMLElement | null = chip; el; el = el.parentElement) {
        const bg = parse(getComputedStyle(el).backgroundColor);
        if (bg.a > 0) stack.push(bg);
        if (bg.a >= 1) break;
      }
      if (!stack.length || stack[stack.length - 1].a < 1) throw new Error('no opaque ground under the chip');
      const composed = stack.reduceRight((under, top) => top.rgb.map((v, i) => v * top.a + under[i] * (1 - top.a)), [0, 0, 0]);
      const text = parse(getComputedStyle(chip).color);
      const [hi, lo] = [lum(text.rgb), lum(composed)].sort((p, q) => q - p);
      return {
        ground: chip.closest<HTMLElement>('[data-ground]')!.dataset.ground!,
        row: chip.closest<HTMLElement>('[data-row]')!.dataset.row!,
        chip: chip.dataset.chip!,
        text: getComputedStyle(chip).color,
        layers: stack.length,
        ratio: (hi + 0.05) / (lo + 0.05),
      };
    });
  });
}

const failing = (readings: Reading[]) => readings.filter((r) => r.ratio < 4.5)
  .map((r) => `${r.chip} chip on the ${r.row} row over ${r.ground}: ${r.ratio.toFixed(2)}`);

test.describe('a status chip on a status-tinted row', () => {
  test('light theme: every chip clears 4.5:1 on its composed ground', async ({ page }) => {
    await openFixture(page, 'light');
    const readings = await measure(page);
    // 3 grounds x 2 rows x 3 chips, each over the row's tint and its own.
    expect(readings).toHaveLength(18);
    for (const r of readings) expect(r.layers, `${r.chip} on ${r.row} over ${r.ground}`).toBe(3);
    expect(failing(readings)).toEqual([]);
  });

  test('light theme, control: the previous warning token fails on the same ground', async ({ page }) => {
    await openFixture(page, 'light');
    // The value before this change, set on the fixture so only it is affected.
    await page.locator('#fixture').evaluate((el) => el.style.setProperty('--warning', '129 93 16'));
    const readings = await measure(page);
    expect(readings.find((r) => r.chip === 'warning')!.text).toBe('rgb(129, 93, 16)');
    expect(failing(readings)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^warning chip on the snoozed row over bg-bg: 4\.2\d$/),
      expect.stringMatching(/^warning chip on the overdue row over bg-bg: 4\.2\d$/),
    ]));
  });

  test('dark theme: every chip clears 4.5:1 on its composed ground', async ({ page }) => {
    await openFixture(page, 'dark');
    const readings = await measure(page);
    expect(readings).toHaveLength(18);
    expect(failing(readings)).toEqual([]);
  });
});
