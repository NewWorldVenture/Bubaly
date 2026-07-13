import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PUBLIC_ROUTES } from './public-routes';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('public route accessibility', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const path of PUBLIC_ROUTES) {
      test(`${path} has no serious WCAG violations in ${theme} mode`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem('bubaly-theme', selectedTheme);
        }, theme);
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        const violations = results.violations.filter(
          (violation) => violation.impact === 'critical' || violation.impact === 'serious',
        );
        const summary = violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            html: node.html,
            failureSummary: node.failureSummary,
          })),
        }));

        expect(summary, `${path} ${theme}-mode accessibility violations`).toEqual([]);
      });
    }
  }
});
