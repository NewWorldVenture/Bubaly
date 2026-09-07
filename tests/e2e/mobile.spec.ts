import { test, expect } from '@playwright/test';
import { PUBLIC_ROUTES } from './public-routes';

// Mobile production-readiness (Phase 2/3 — device matrix). Runs under the emulated
// mobile projects in playwright.config.ts (iPhone SE / iPhone 14 Pro / Pixel 7 /
// iPad). Asserts the mobile-critical DOM invariants on every public route at the
// device's REAL viewport (touch, DPR, UA) — not just a resized desktop window.
//
// What it locks (runtime, per device):
//   1. viewport meta is present and opts into safe areas (viewport-fit=cover).
//   2. no unintended horizontal page scroll.
//   3. no focusable text input renders < 16px (iOS/iPadOS zoom-on-focus guard,
//      M-002) — verified from the *computed* style, so it catches any input the
//      global CSS rule missed.
//   4. the floating language picker does not cover any on-screen control.

test.describe('mobile invariants on public routes', () => {
  test('viewport meta opts into safe areas', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content, 'viewport meta present').toBeTruthy();
    expect(content).toContain('width=device-width');
    expect(content).toContain('viewport-fit=cover');
  });

  for (const path of PUBLIC_ROUTES) {
    test(`${path}: no horizontal overflow + no sub-16px inputs`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => new Promise(requestAnimationFrame));

      // (2) No horizontal page scroll at this device's native width.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
      });
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);

      // (3) No focusable text input under 16px (would trigger iOS zoom-on-focus).
      const smallInputs = await page.evaluate(() => {
        const bad: string[] = [];
        const sel = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]),textarea,select';
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          if (el.offsetParent === null) continue; // skip hidden
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs && fs < 16) bad.push(`${el.tagName.toLowerCase()}@${Math.round(fs)}px`);
        }
        return bad;
      });
      expect(smallInputs, `${path} has inputs < 16px (iOS will zoom): ${smallInputs.join(', ')}`).toEqual([]);

      // (4) A language control is reachable on every route, and it covers
      // nothing.
      //
      // It shipped floating: 214px wide — 54% of a phone — at z-90, which put
      // its body across the click point of any full-width button in its band
      // and outranked the cookie banner and the PWA prompt. Hit-testing found
      // it covering a control on 13 of 28 route/device combinations. It is
      // embedded in the bottom of each layout now and cannot, but the hit test
      // stays: none of that was visible to a DOM-only check — the element is
      // present, styled and "visible", and only a probe at the point a finger
      // actually lands shows the picker answering instead of the button. Making
      // it fixed again would regress silently otherwise.
      const language = await page.evaluate(() => {
        const pickers = Array.from(document.querySelectorAll('[data-testid="language-picker"]'));
        if (!pickers.length) return { present: false, blocked: [] as string[] };

        const blocked: string[] = [];
        const sel = 'a[href],button,input,select,textarea,[role=button]';
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          if (pickers.some((p) => p.contains(el))) continue;
          const r = el.getBoundingClientRect();
          // Only controls wholly on screen: a partially-scrolled element has no
          // meaningful click point yet, and clamping one into view invents a
          // collision that a real tap would never make.
          if (r.width < 1 || r.height < 1) continue;
          if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) continue;
          if (getComputedStyle(el).visibility === 'hidden') continue;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit && pickers.some((p) => p.contains(hit))) {
            blocked.push((el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40));
          }
        }
        return { present: true, blocked };
      });
      expect(language.present, `${path} renders no language control`).toBe(true);
      expect(language.blocked, `${path}: language picker covers ${language.blocked.join(' | ')}`).toEqual([]);
    });
  }
});
