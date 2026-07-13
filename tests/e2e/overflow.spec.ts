import { test, expect } from '@playwright/test';
import { PUBLIC_ROUTES } from './public-routes';

// The mobile-foundation pass called this "the single most valuable next step":
// assert no route scrolls horizontally at real device widths. Public routes run
// today (no auth needed); extend PUBLIC_ROUTES → authed routes once CI has a
// Supabase login. Resizing the viewport (no reload) is enough to surface CSS
// overflow, so each route costs one navigation.
// Phone (smallest supported), modern phone, tablet portrait, small laptop.
const WIDTHS = [320, 390, 768, 1024];

test.describe('no horizontal overflow on public routes', () => {
  for (const path of PUBLIC_ROUTES) {
    test(`${path} fits every width`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 844 });
        // Let responsive layout settle (fonts/images may still stream; layout
        // reflow after resize is synchronous once rAF fires).
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
        });
        // 1px tolerance for subpixel rounding on some engines.
        expect(overflow, `${path} overflows by ${overflow}px at ${width}px wide`).toBeLessThanOrEqual(1);
      }
    });
  }
});
