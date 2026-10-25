import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// A11Y-001, WCAG 2.4.7 and 1.4.11: a text field that drew only its caret on
// focus now marks it, as the built CSS paints it.
//
// tests/a-focused-control-shows-it.test.ts holds the source for all fourteen;
// this holds what the browser renders for one of each shape: a bordered search
// box that rings outside itself while its input has focus (the meals recipe
// search), a row flush with a clipped panel that rings inside itself (the
// command bar), and the assistant's composer, whose own border turns brand
// under its glow. Each is built from its own class strings, read from the
// source, and placed on the sign-in page (no account needed) over each page
// ground in both themes. Focused, the mark must be painted (a ring with a
// spread, or a solid border with a width), be --brand, and read at 3:1 against
// the ground; blurred, it must be gone.
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const browserFailures = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') failures.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => failures.push(`request failed: ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`));
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`); });
});
test.afterEach(({ page }) => {
  expect(browserFailures.get(page), 'no console, page, request or HTTP failures').toEqual([]);
});

function sourceString(file: string, pattern: RegExp, what: string): string {
  const m = readFileSync(file, 'utf8').match(pattern);
  if (!m) throw new Error(`${what} not found in ${file}`);
  return m[1];
}

type Shape = { id: string; kind: 'ring' | 'border'; box: string; input: string; before: string };

const ADDED_RING = / focus-within:ring-2 focus-within:ring-(inset focus-within:ring-brand|brand focus-within:ring-offset-2 focus-within:ring-offset-bg)/;

const SHAPES: Shape[] = (() => {
  const mealsBox = sourceString('components/modules/meals-module.tsx', /<div className="(mb-3 flex items-center gap-1\.5 rounded-xl [^"]+)">\s*<Search/, 'the recipe search box');
  const barRow = sourceString('components/app/command-bar.tsx', /<div className="(flex items-center gap-2 border-b border-border px-4[^"]*)">\s*<Search/, "the command bar's search row");
  const composer = sourceString('components/modules/assistant-module.tsx', /<div className="(ai-composer flex items-center [^"]+)">/, "the assistant's bar composer");
  return [
    { id: 'meals recipe search', kind: 'ring', box: mealsBox, before: mealsBox.replace(ADDED_RING, ''),
      input: sourceString('components/modules/meals-module.tsx', /setRecipeSearch\(e\.target\.value\)\}[^\n]*\n\s*className="([^"]+)"/, 'the recipe search input') },
    { id: 'command bar', kind: 'ring', box: barRow, before: barRow.replace(ADDED_RING, ''),
      input: sourceString('components/app/command-bar.tsx', /placeholder=\{t\('commandBar\.searchAddATaskOrAsk'\)\}[\s\S]*?className="([^"]+)"/, "the command bar's input") },
    { id: 'assistant composer', kind: 'border', box: composer, before: composer.replace(/ border(?= )| focus-within:border-brand/g, ''),
      input: sourceString('components/modules/assistant-module.tsx', /<input\s+className="([^"]+)"\s+placeholder=\{micStatus/, "the composer's input") },
  ];
})();

const GROUNDS = ['bg-bg', 'bg-surface', 'bg-elevated'];

async function open(page: Page, theme: 'light' | 'dark', which: 'box' | 'before') {
  await page.addInitScript((t) => { try { localStorage.setItem('bubaly-theme', t); } catch { /* private mode */ } }, theme);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  await expect(page.locator('input[name="email"]')).toBeEditable();
  const html = `<div id="fixture"><span data-brand class="bg-brand"></span>${GROUNDS.map((g) => SHAPES.map((s) => `
    <div data-ground="${g}" data-shape="${s.id}" data-kind="${s.kind}" class="${g} p-4" style="width:320px">
      <div data-paint class="${s[which]}"><input data-focus class="${s.input}" placeholder="Search"></div>
    </div>`).join('')).join('')}</div>`;
  await page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), html);
}

type Reading = { shape: string; ground: string; painted: boolean; isBrand: boolean; ratio: number; detail: string };

/** Each shape's mark, read from the computed style with its input focused, or after it is blurred. */
async function read(page: Page, focused: boolean): Promise<Reading[]> {
  const out: Reading[] = [];
  const cells = page.locator('#fixture [data-shape]');
  for (let i = 0; i < await cells.count(); i++) {
    const cell = cells.nth(i);
    if (focused) await cell.locator('[data-focus]').focus();
    else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(300); // past the composer's 200 ms border transition
    out.push(await cell.evaluate((c) => {
      const rgba = (s: string) => { const n = s.match(/rgba?\(([^)]+)\)/)![1].match(/[\d.]+/g)!.map(Number); return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 }; };
      const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]: number[]) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const brand = rgba(getComputedStyle(document.querySelector('[data-brand]')!).backgroundColor).rgb.join(',');
      const ground = rgba(getComputedStyle(c).backgroundColor).rgb;
      const box = c.querySelector('[data-paint]') as HTMLElement;
      const cs = getComputedStyle(box);
      const base = { shape: c.dataset.shape!, ground: c.dataset.ground! };
      if (c.dataset.kind === 'ring') {
        // A painted ring is a box-shadow layer with a spread and a colour that shows.
        const layers = cs.boxShadow === 'none' ? [] : cs.boxShadow.split(/,(?![^(]*\))/).map((l) => l.trim());
        const ring = layers.map((l) => ({ c: rgba(l), spread: Number(l.replace(/rgba?\([^)]*\)/, '').trim().split(/\s+/)[3]?.replace('px', '') ?? 0) }))
          .filter((l) => l.spread >= 2 && l.c.a > 0 && l.c.rgb.join(',') === brand);
        const painted = ring.length > 0;
        return { ...base, painted, isBrand: painted, ratio: painted ? ratio(ring[0].c.rgb, ground) : 0, detail: cs.boxShadow };
      }
      const width = parseFloat(cs.borderLeftWidth);
      const colour = rgba(cs.borderLeftColor);
      const painted = width >= 1 && cs.borderLeftStyle === 'solid' && colour.a === 1;
      return { ...base, painted, isBrand: colour.rgb.join(',') === brand, ratio: ratio(colour.rgb, ground), detail: `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}` };
    }));
  }
  return out;
}

test.describe('a text field shows its focus', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: each shape marks focus in --brand at 3:1 on every ground, and drops it on blur`, async ({ page }) => {
      await open(page, theme, 'box');
      const focused = await read(page, true);
      expect(focused).toHaveLength(SHAPES.length * GROUNDS.length);
      for (const r of focused) {
        const at = `${r.shape} on ${r.ground} (${r.detail})`;
        expect(r.painted, `${at}: painted`).toBe(true);
        expect(r.isBrand, `${at}: --brand`).toBe(true);
        expect(r.ratio, `${at}: against the ground`).toBeGreaterThanOrEqual(3);
      }
      for (const r of await read(page, false)) expect(r.isBrand && r.painted, `${r.shape} on ${r.ground} blurred (${r.detail})`).toBe(false);
    });
  }

  test('dark, control: the previous classes mark nothing in --brand on focus', async ({ page }) => {
    for (const s of SHAPES) expect(s.before, s.id).not.toBe(s.box); // the previous classes differ
    await open(page, 'dark', 'before');
    for (const r of await read(page, true)) expect(r.isBrand && r.painted && r.ratio >= 3, `${r.shape} on ${r.ground} (${r.detail})`).toBe(false);
  });
});
