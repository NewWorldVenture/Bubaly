import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// A11Y-001, WCAG 1.4.11: a field's own focus colour, as the built CSS paints it.
//
// tests/a-focus-colour-reads-at-3-to-1.test.ts holds the arithmetic for every
// class string; this holds what the browser renders for one field of each
// shape: a <select> whose border turns brand (reminders, on its bg-surface/60
// fill; the wallet's goal picker, on bg-bg), a search field that rings
// (inbox), and a form whose border turns brand while its input has focus
// (the home ask bar). Each is built from its own class string, read from the
// source, and placed on the sign-in page (no account needed) over each page
// ground in both themes. The focused border or ring is read from the computed
// style and measured against the ground, and a border against the field's own
// fill as well.
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

// Every original CSS case keeps its assertions and also reports browser failures.
const browserFailures = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      failures.push('console ' + message.type() + ': ' + message.text());
    }
  });
  page.on('pageerror', error => failures.push('page error: ' + error.message));
  page.on('requestfailed', request => failures.push('request failed: ' + request.url() + ': ' + (request.failure()?.errorText ?? 'unknown')));
  page.on('response', response => {
    if (response.status() >= 400) failures.push('HTTP ' + response.status() + ': ' + response.url());
  });
});
test.afterEach(({ page }) => {
  const failures = browserFailures.get(page);
  expect(failures, 'browser collectors were installed for this original case').toBeDefined();
  expect(failures, 'original CSS case has no console, page, request or HTTP failures').toEqual([]);
});

function sourceString(file: string, pattern: RegExp, what: string): string {
  const m = readFileSync(file, 'utf8').match(pattern);
  if (!m) throw new Error(`${what} not found in ${file}`);
  return m[1];
}

type Field = { id: string; kind: 'border' | 'ring'; html: (cls: string) => string; cls: string };

const FIELDS: Field[] = [
  {
    id: 'reminders priority', kind: 'border',
    cls: sourceString('components/modules/reminders-module.tsx', /<select id=\{id\} name="priority"[^\n]*\n\s*className="([^"]+)"/, "the reminder form's priority select"),
    html: (cls) => `<select data-focus class="${cls}"><option>Medium</option></select>`,
  },
  {
    id: 'wallet goal picker', kind: 'border',
    cls: sourceString('components/wallet/goals-view.tsx', /<select id=\{id\} value=\{childId\}[^\n]*\n\s*className="([^"]+)"/, "the goal form's child select"),
    html: (cls) => `<select data-focus class="${cls}"><option>Family goal</option></select>`,
  },
  {
    id: 'inbox search', kind: 'ring',
    cls: sourceString('components/modules/inbox-module.tsx', /placeholder=\{tr\('inbox\.searchMessagesContacts'\)\}\s*className="([^"]+)"/, "the inbox search"),
    html: (cls) => `<input data-focus class="${cls}" placeholder="Search">`,
  },
  {
    id: 'home ask bar', kind: 'border',
    cls: sourceString('components/dashboard/home-ask-bar.tsx', /<form[\s\S]*?className="([^"]+)"/, "the home ask bar"),
    html: (cls) => `<form data-paint class="${cls}"><input data-focus class="flex-1 bg-transparent outline-none" placeholder="Ask"></form>`,
  },
];

const GROUNDS = ['bg-bg', 'bg-surface', 'bg-elevated'];

async function open(page: Page, theme: 'light' | 'dark', fields: Field[]) {
  await page.addInitScript((t) => { try { localStorage.setItem('bubaly-theme', t); } catch { /* private mode */ } }, theme);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  await expect(page.locator('input[name="email"]')).toBeEditable();
  const html = `<div id="fixture">${GROUNDS.map((g) => fields.map((f) => `
    <div data-ground="${g}" data-field="${f.id}" data-kind="${f.kind}" class="${g} p-4" style="width:280px">${f.html(f.cls)}</div>`).join('')).join('')}</div>`;
  await page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), html);
}

type Reading = { field: string; ground: string; ratio: number; against: string };

/** Focus each field in turn; measure its border or ring against the ground, and a border against its fill. */
async function measure(page: Page): Promise<Reading[]> {
  const out: Reading[] = [];
  const cells = page.locator('#fixture [data-field]');
  for (let i = 0; i < await cells.count(); i++) {
    const cell = cells.nth(i);
    await cell.locator('[data-focus]').focus();
    await page.waitForTimeout(250); // past the fields' 150 ms colour transition
    out.push(...await cell.evaluate((c) => {
      const rgba = (s: string) => { const n = s.match(/rgba?\(([^)]+)\)/)![1].match(/[\d.]+/g)!.map(Number); return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 }; };
      const over = (top: { rgb: number[]; a: number }, under: number[]) => top.rgb.map((v, k) => v * top.a + under[k] * (1 - top.a));
      const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]: number[]) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const ground = rgba(getComputedStyle(c).backgroundColor).rgb;
      const el = (c.querySelector('[data-paint]') ?? c.querySelector('[data-focus]')) as HTMLElement;
      const cs = getComputedStyle(el);
      const fill = over(rgba(cs.backgroundColor), ground);
      const base = { field: c.dataset.field!, ground: c.dataset.ground! };
      if (c.dataset.kind === 'ring') {
        // The ring is the box-shadow layer with a spread; Tailwind lists the offset layer first.
        const layers = cs.boxShadow.split(/,(?![^(]*\))/).map((l) => l.trim()).filter((l) => !/ 0px$/.test(l));
        const ring = layers.find((l) => rgba(l).a > 0);
        if (!ring) return [{ ...base, ratio: 0, against: 'ground (no ring painted)' }];
        return [{ ...base, ratio: ratio(over(rgba(ring), ground), ground), against: 'ground' }];
      }
      if (parseFloat(cs.borderLeftWidth) <= 0 || cs.borderLeftStyle === 'none' || cs.borderLeftStyle === 'hidden') {
        return [{ ...base, ratio: 0, against: 'ground (no border painted)' }, { ...base, ratio: 0, against: 'its fill (no border painted)' }];
      }
      const border = over(rgba(cs.borderLeftColor), fill);
      return [{ ...base, ratio: ratio(border, ground), against: 'ground' }, { ...base, ratio: ratio(border, fill), against: 'its fill' }];
    }));
  }
  return out;
}

const failing = (r: Reading[]) => r.filter((x) => x.ratio < 3).map((x) => `${x.field} on ${x.ground}, against ${x.against}: ${x.ratio.toFixed(2)}`);

test.describe('a field’s own focus colour reads at 3:1', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: each field’s focused border or ring, on every ground`, async ({ page }) => {
      await open(page, theme, FIELDS);
      const readings = await measure(page);
      // 4 fields x 3 grounds; a border is read against the ground and its fill, a ring against the ground.
      expect(readings).toHaveLength(3 * (3 * 2 + 1));
      expect(failing(readings)).toEqual([]);
    });
  }

  // The previous classes are gone from the source, so the built CSS has no rule
  // for them: the control lays the previous colour on inline instead.
  test('dark, control: the same fields at the previous brand/50 border and brand/30 ring fall short', async ({ page }) => {
    await open(page, 'dark', FIELDS);
    const applied = await page.locator('#fixture [data-field]').evaluateAll((cells) => cells.map((c) => {
      const el = (c.querySelector('[data-paint]') ?? c.querySelector('[data-focus]')) as HTMLElement;
      el.style.transition = 'none';
      if ((c as HTMLElement).dataset.kind === 'ring') el.style.setProperty('--tw-ring-color', 'rgb(var(--brand) / 0.3)');
      else el.style.borderColor = 'rgb(var(--brand) / 0.5)';
      return getComputedStyle(el).borderLeftColor;
    }));
    expect(applied.filter((c) => /\/ 0\.5\)|, 0\.5\)$/.test(c)).length).toBe(3 * 3); // the three border fields, on three grounds
    const short = failing(await measure(page));
    for (const f of FIELDS) expect(short.some((s) => s.startsWith(f.id)), f.id).toBe(true);
  });
});


// These source fields live under app/(marketing)/layout.tsx's marketing-theme.
// Its light border remap participates in the cascade and must be present here.
const MARKETING_FIELDS: Field[] = [
  {
    id: 'blog search', kind: 'border',
    cls: sourceString('app/(marketing)/blog/blog-search.tsx', /<div className="([^"]*focus-within:border-brand[^"]*)"/, 'the marketing blog search'),
    html: (cls) => `<div data-paint class="${cls}"><input data-focus class="bg-transparent outline-none" aria-label="Blog search"></div>`,
  },
  {
    id: 'subscribe email', kind: 'border',
    cls: sourceString('components/blog/subscribe-form.tsx', /'([^'\n]*focus:border-brand[^'\n]*)'/, 'the marketing subscribe email'),
    html: (cls) => `<input data-focus class="${cls}" aria-label="Subscribe email">`,
  },
  {
    id: 'FAQ search', kind: 'border',
    cls: sourceString('components/marketing/faq-explorer.tsx', /className="([^"]*focus:border-brand[^"\n]*)"/, 'the marketing FAQ search'),
    html: (cls) => `<input data-focus class="${cls}" aria-label="FAQ search">`,
  },
];

test.describe('marketing focus paint with the actual marketing ancestry', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const field of MARKETING_FIELDS) {
      test(`${theme}: ${field.id} paints focus on every ground and retires on blur`, async ({ page }) => {
        await open(page, theme, [field]);
        await page.locator('#fixture').evaluate((fixture) => {
          const marketing = document.createElement('main');
          marketing.className = 'marketing-theme';
          fixture.parentNode!.insertBefore(marketing, fixture);
          marketing.appendChild(fixture);
        });
        const cells = page.locator('#fixture [data-field]');
        await expect(cells).toHaveCount(GROUNDS.length);
        for (let i = 0; i < await cells.count(); i++) {
          const cell = cells.nth(i);
          const paint = () => cell.evaluate((c) => {
            const el = (c.querySelector('[data-paint]') ?? c.querySelector('[data-focus]')) as HTMLElement;
            const cs = getComputedStyle(el);
            return { colour: cs.borderLeftColor, width: parseFloat(cs.borderLeftWidth), style: cs.borderLeftStyle };
          });
          await page.locator('input[name="email"]').focus();
          await page.waitForTimeout(250);
          const unfocused = await paint();
          await cell.locator('[data-focus]').focus();
          await expect(cell.locator('[data-focus]')).toBeFocused();
          await page.waitForTimeout(250);
          const focused = await paint();
          expect(focused.width).toBeGreaterThan(0);
          expect(focused.style).toBe('solid');
          expect(focused.colour).not.toEqual(unfocused.colour);
          await page.locator('input[name="email"]').focus();
          await page.waitForTimeout(250);
          expect((await paint()).colour).toEqual(unfocused.colour);
        }
        const readings = await measure(page);
        expect(readings).toHaveLength(GROUNDS.length * 2);
        expect(failing(readings)).toEqual([]);
      });
    }
  }

  test('a strong computed border colour with zero width is refused by the browser measurement', async ({ page }) => {
    await open(page, 'light', [{
      id: 'no painted border', kind: 'border', cls: 'border-0 outline-none focus:border-brand bg-bg',
      html: (cls) => `<input data-focus class="${cls}">`,
    }]);
    const readings = await measure(page);
    expect(readings).toHaveLength(GROUNDS.length * 2);
    expect(readings.every((r) => r.ratio === 0 && r.against.includes('no border painted'))).toBe(true);
    const styles = await page.locator('#fixture [data-focus]').evaluateAll((fields) => fields.map((el) => {
      const cs = getComputedStyle(el);
      return { width: parseFloat(cs.borderLeftWidth), colour: cs.borderLeftColor };
    }));
    expect(styles.every((s) => s.width === 0)).toBe(true);
  });
});
