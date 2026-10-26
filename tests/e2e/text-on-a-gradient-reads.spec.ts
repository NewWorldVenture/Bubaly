import { expect, test, type Page } from '@playwright/test';

// A11Y-001, WCAG 1.4.3: words on a gradient read at 4.5:1, as the built CSS
// paints them.
//
// tests/text-on-a-gradient-reads-at-4-5-to-1.test.ts holds the source for
// every gradient that carries text; this holds what the browser renders on the
// public pages that carry the call-to-action gradient: the header's CTA on
// each, the home page's, pricing's featured plan, the security page's three
// (which used to take the page's ink) and the FAQ's. Every text node whose
// nearest painted ancestor is a gradient is read: its computed colour against
// each colour stop, at rest and then hovered, with the hover's brightness
// filter applied to text and fill alike.
test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });

// Three things a marketing page does that are not failures: it registers its
// service worker, which this spec blocks; it prefetches the routes its links
// point to; and it sends a keepalive analytics beacon. The next page.goto
// cancels the last two.
const EXPECTED = (line: string) => line === 'console warning: Service Worker registration blocked by Playwright'
  || /^request failed: \S+[?&]_rsc=\S+: net::ERR_ABORTED$/.test(line)
  || /^request failed: \S+\/api\/mkt\/track: net::ERR_ABORTED$/.test(line);

const browserFailures = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  // The pages' analytics and exit-intent beacons are not under test, and they
  // are rate-limited per address: a run on a server that has already served
  // many page loads would read their 429s as browser failures. Answer them as
  // an idle visitor would get answered: tracked, and no offer.
  await page.route('**/api/mkt/track', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/exit-intent/resolve', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"offer":null}' }));
  const failures: string[] = [];
  browserFailures.set(page, failures);
  const fail = (line: string) => { if (!EXPECTED(line)) failures.push(line); };
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') fail(`console ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => fail(`request failed: ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`));
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`); });
});
test.afterEach(({ page }) => {
  expect(browserFailures.get(page), 'no console, page, request or HTTP failures').toEqual([]);
});

const PAGES = ['/', '/pricing', '/security', '/faq'];

type Reading = { text: string; ratio: number; ink: string; stops: string; filter: string };

/** Each gradient that carries its own text, marked with data-gradient-cta, and the count. */
async function markGradients(page: Page): Promise<number> {
  return page.evaluate(() => {
    const paints = (el: Element) => {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
      return cs.backgroundImage !== 'none' || (bg.length > 3 ? bg[3] > 0 : bg.length === 3);
    };
    const marked = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/[\p{L}\p{N}]/u.test(n.textContent ?? '') || n.parentElement?.closest('[aria-hidden="true"]')) continue;
      let el = n.parentElement;
      while (el && !paints(el)) el = el.parentElement;
      if (!el || !/linear-gradient/.test(getComputedStyle(el).backgroundImage)) continue;
      const stops = [...getComputedStyle(el).backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => m[1].split(/[\s,/]+/).filter(Boolean).map(Number));
      if (stops.some((s) => s.length > 3 && s[3] < 1)) continue; // a translucent tint, not a fill
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      marked.add(el);
    }
    let i = 0;
    for (const el of marked) el.setAttribute('data-gradient-cta', String(i++));
    return marked.size;
  });
}

/** One gradient's worst text-to-stop contrast, as painted now. */
async function read(page: Page, i: number): Promise<Reading> {
  return page.locator(`[data-gradient-cta="${i}"]`).evaluate((el) => {
    const rgb = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]: number[]) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const cs = getComputedStyle(el);
    const f = Number(/brightness\(([\d.]+)\)/.exec(cs.filter)?.[1] ?? 1);
    const lit = (c: number[]) => c.map((v) => Math.min(255, Math.round(v * f)));
    const stops = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => rgb(m[0]));
    const inks = [...el.querySelectorAll('*'), el].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /[\p{L}\p{N}]/u.test(n.textContent ?? ''))).map((e) => rgb(getComputedStyle(e).color));
    const worst = Math.min(...inks.flatMap((ink) => stops.map((s) => ratio(lit(ink), lit(s)))));
    return { text: (el.textContent ?? '').trim().slice(0, 40), ratio: worst, ink: inks.map((c) => c.join(',')).join(' '), stops: stops.map((c) => c.join(',')).join(' → '), filter: cs.filter };
  });
}

async function open(page: Page, theme: 'light' | 'dark', path: string) {
  await page.addInitScript((t) => { try { localStorage.setItem('bubaly-theme', t); } catch { /* private mode */ } }, theme);
  await page.goto(path, { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

test.describe('text on a gradient reads at 4.5:1', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: each CTA's words read at 4.5:1 on every stop, at rest and hovered`, async ({ page }) => {
      test.setTimeout(90_000); // four pages, and a hover on every CTA on each
      let total = 0;
      for (const path of PAGES) {
        await open(page, theme, path);
        const n = await markGradients(page);
        expect(n, `${path}: at least the header's CTA`).toBeGreaterThan(0);
        total += n;
        for (let i = 0; i < n; i++) {
          const cta = page.locator(`[data-gradient-cta="${i}"]`);
          const rest = await read(page, i);
          expect(rest.ratio, `${path} "${rest.text}" at rest: ${rest.ink} on ${rest.stops}`).toBeGreaterThanOrEqual(4.5);
          if (!(await cta.isVisible())) continue; // the mobile menu's copy, closed at this width
          await cta.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await cta.hover({ force: true });
          await page.waitForTimeout(250); // past the transition
          const hovered = await read(page, i);
          expect(hovered.ratio, `${path} "${hovered.text}" hovered (${hovered.filter}): ${hovered.ink} on ${hovered.stops}`).toBeGreaterThanOrEqual(4.5);
          await page.mouse.move(0, 0);
        }
      }
      expect(total, 'the header CTA on each page, plus the pages\' own').toBeGreaterThanOrEqual(PAGES.length + 5);
    });
  }

  test('light, control: the security page CTAs at the previous blue-500 start and the page\'s ink fall short', async ({ page }) => {
    await open(page, 'light', '/security');
    const n = await markGradients(page);
    const previous = await page.locator('[data-gradient-cta]').evaluateAll((els) => els.filter((el) => /security|privacy|assistant/i.test(el.textContent ?? '')).map((el) => {
      const e = el as HTMLElement;
      e.classList.remove('text-brand-fg');
      e.style.backgroundImage = 'linear-gradient(to right, rgb(59, 130, 246), rgb(124, 58, 237))';
      return e.dataset.gradientCta!;
    }));
    expect(n).toBeGreaterThan(previous.length);
    expect(previous.length, 'the three security CTAs').toBe(3);
    for (const i of previous) expect((await read(page, Number(i))).ratio).toBeLessThan(4.5);
  });
});
