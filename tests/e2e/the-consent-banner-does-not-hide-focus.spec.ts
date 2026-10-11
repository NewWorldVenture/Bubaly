import { expect, test, type Page } from '@playwright/test';

// A11Y-001, WCAG 2.4.11 (focus not obscured): the first-load cookie banner is
// fixed to the bottom of every marketing page. Tabbing down a page with it up
// used to focus controls hidden behind it; the footer's Privacy, Terms,
// Acceptable Use and Cookies links on every marketing page at 1280 px, and far
// more at 390 px, where it spans the width. While it shows, the page now
// reserves its height (scroll padding and end-of-page padding).

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

type Stop = { text: string; covered: boolean; inBanner: boolean };

/** Tab through the page from the top and say, for each stop, whether the banner covers it. */
async function walk(page: Page, max: number): Promise<Stop[]> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const stops: Stop[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const banner = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Cookie consent"]');
      if (!el || el === document.body) return null;
      const inBanner = !!banner && banner.contains(el);
      const r = el.getBoundingClientRect();
      let covered = false;
      if (banner && !inBanner) {
        const b = banner.getBoundingClientRect();
        // Any overlap with the banner, not only the centre: 2.4.11 is about
        // the control being hidden, and a half-hidden link reads as hidden.
        covered = r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right;
      }
      return { text: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40), covered, inBanner };
    });
    if (!stop) continue;
    if (stops.length && stops[0].text === stop.text && stops.length > 3) break; // wrapped round
    stops.push(stop);
  }
  return stops;
}

for (const width of [1280, 390]) {
  test(`at ${width} px, no control the keyboard reaches is hidden behind the cookie banner`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/privacy', { waitUntil: 'networkidle' });
    const banner = page.getByRole('dialog', { name: 'Cookie consent' });
    await expect(banner).toBeVisible();

    const stops = await walk(page, 120);
    // Non-vacuity: the walk got to the end of the page, the footer's legal links.
    expect(stops.map((s) => s.text)).toEqual(expect.arrayContaining(['Terms', 'Cookies']));
    expect(stops.filter((s) => s.covered).map((s) => s.text)).toEqual([]);

    // Choosing puts the page back as it was.
    await page.getByRole('button', { name: 'Reject non-essential' }).click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => [document.documentElement.style.scrollPaddingBottom, document.body.style.paddingBottom])).toEqual(['', '']);
    await context.close();
  });
}

/** Where the focused control is against the viewport and the banner, as the page left it (no scrolling here). */
async function focusPlace(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const banner = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Cookie consent"]');
    const r = el?.getBoundingClientRect();
    const b = banner?.getBoundingClientRect();
    return {
      trigger: !!el?.hasAttribute('data-test-trigger'),
      banner: !!banner,
      inView: !!r && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      covered: !!r && !!b && r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right,
    };
  });
}

// The undecided visitor reopens the choices from the footer and backs out with
// Escape. Opening them takes the banner away, and with it the space reserved
// for it, which shifts a page scrolled to its end; closing puts focus back on
// the footer link before the banner and its space return. The link must come
// back focused and clear of the banner, without the test scrolling it: each
// round, then after the window changes size while the choices are open. Once
// with reduced motion, once with the banner's entrance animation and the
// page's smooth scrolling left on.
const ROUND_TRIPS = [
  { width: 1280, motion: false, sizes: [{ width: 1280, height: 800 }, { width: 1280, height: 800 }, { width: 1024, height: 640 }] },
  { width: 390, motion: false, sizes: [{ width: 390, height: 844 }, { width: 390, height: 844 }, { width: 360, height: 640 }] },
  { width: 390, motion: true, sizes: [{ width: 390, height: 844 }, { width: 390, height: 844 }, { width: 360, height: 640 }] },
];
for (const { width, motion, sizes } of ROUND_TRIPS) {
  test(`at ${width} px${motion ? ', motion on' : ''}, Privacy choices → preferences → Escape returns focus to the link, clear of the banner, every time and after a resize`, async ({ browser }) => {
    const mobile = width === 390;
    const context = await browser.newContext({ viewport: sizes[0], ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: motion ? 'no-preference' : 'reduce' });
    await page.goto('/privacy', { waitUntil: 'networkidle' });
    const banner = page.getByRole('dialog', { name: 'Cookie consent' });
    await expect(banner).toBeVisible();

    // Tab to the footer's Privacy choices, as a keyboard visitor would.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    let reached = false;
    for (let i = 0; i < 200 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el?.textContent?.trim() !== 'Privacy choices' || el.closest('[role="dialog"]')) return false;
        el.setAttribute('data-test-trigger', '');
        return true;
      });
    }
    expect(reached, 'the walk reaches Privacy choices').toBe(true);
    const clear = { trigger: true, banner: true, inView: true, covered: false };
    await expect.poll(() => focusPlace(page)).toEqual(clear);

    const preferences = page.getByRole('dialog', { name: 'Privacy preferences' });
    for (const [round, size] of sizes.entries()) {
      await page.keyboard.press('Enter');
      await expect(preferences).toBeVisible();
      await expect(banner).toHaveCount(0);
      if (round === sizes.length - 1) await page.setViewportSize(size);
      await page.keyboard.press('Escape');
      await expect(preferences).toHaveCount(0);
      await expect(banner).toBeVisible();
      // Polled, not scrolled: the page settles (an animation, a smooth scroll) on its own.
      await expect.poll(() => focusPlace(page), { message: `round ${round + 1} at ${size.width}×${size.height}` }).toEqual(clear);
    }
    await context.close();
  });
}
