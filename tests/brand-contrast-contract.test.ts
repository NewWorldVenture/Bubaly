import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);

function collectSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSource(path);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('accessible brand color roles', () => {
  it('defines separate action-background and text colors in both themes', () => {
    const globals = readFileSync(resolve('app/globals.css'), 'utf8');
    const tailwind = readFileSync(resolve('tailwind.config.ts'), 'utf8');

    expect(globals.match(/--brand-text:/g)).toHaveLength(2);
    expect(tailwind).toContain("text: 'rgb(var(--brand-text) / <alpha-value>)'");
  });

  it('does not reuse the solid brand color for text', () => {
    const source = [collectSource(resolve('app')), collectSource(resolve('components')), collectSource(resolve('lib'))].join('\n');
    expect(source).not.toMatch(/\btext-brand(?!-[A-Za-z0-9])/);
  });
});

// ── Contrast, measured ────────────────────────────────────────────────────────
//
// The two cases above pin the SHAPE of the brand fix — that a --brand-text token
// exists and that text-brand is never used. Neither computes a ratio, which is why
// they were green while four semantic text colours failed WCAG AA in light mode:
//
//   --accent   2.67    --success  2.91    --warning  2.70    --danger  4.09
//
// across 506 `text-*` sites, 295 of them text-danger. The first three failed even
// the 3:1 floor for large text. Dark mode was 7.13 to 11.74 throughout — which is
// how it went unnoticed, since the app's own default theme is the dark one.
//
// A guard that asserts a token exists cannot see that. These read the tokens out of
// app/globals.css and measure, so the property is checked rather than the solution.

const CHANNEL = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance. */
const luminance = ([r, g, b]: number[]) =>
  0.2126 * CHANNEL(r) + 0.7152 * CHANNEL(g) + 0.0722 * CHANNEL(b);

const contrast = (a: number[], b: number[]) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/**
 * The tokens of one theme block, as `{ name: [r, g, b] }`.
 *
 * Read from the stylesheet rather than duplicated here: a copy would let the two
 * drift, and the drift would be invisible because the copy is what gets asserted.
 */
function tokensOf(css: string, selector: string): Record<string, number[]> {
  const start = css.indexOf(selector);
  expect(start, `${selector} not found in app/globals.css`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, number[]> = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) {
    out[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return out;
}

/** Colours the app renders TEXT in, and which therefore need 4.5:1. */
const TEXT_ROLES = ['fg', 'muted', 'brand-text', 'accent', 'success', 'warning', 'danger', 'info'];

/** Every ground text can land on. `--surface` and `--elevated` are both pure white
 *  in the light theme, so the page background is not always the worst case. */
const GROUNDS = ['bg', 'surface', 'elevated'];

// Reads app/globals.css, and that also covers the Expo app. design/tokens.json holds
// the same four light-mode values and had the same defect — its header calls itself
// "the ONE place the visual language is defined" and mobile/src/theme/tokens.ts imports
// it directly — so the fix had to land in both. tests/design-tokens.test.ts already
// fails on any drift between them, which is what makes checking one enough.
describe('semantic text colours meet WCAG AA', () => {
  const css = readFileSync(resolve('app/globals.css'), 'utf8');

  // `.dark {`, not `:root {`: the dark tokens live under `:root, .dark {` and the
  // FIRST `:root {` in this stylesheet is a different block holding the safe-area
  // insets and no colours at all. Selecting it found zero tokens — which surfaced
  // only because a missing --fg is an error here rather than an empty loop.
  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: every text role clears 4.5:1 on every ground`, () => {
      const tokens = tokensOf(css, selector);
      const failures: string[] = [];
      for (const role of TEXT_ROLES) {
        const colour = tokens[role];
        expect(colour, `--${role} missing from ${selector}`).toBeDefined();
        for (const ground of GROUNDS) {
          const behind = tokens[ground];
          if (!behind) continue;
          const ratio = contrast(colour, behind);
          if (ratio < 4.5) failures.push(`--${role} on --${ground}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures,
        'darken the token in app/globals.css until it reaches 4.5:1 — hold the hue and '
        + 'saturation and reduce lightness only, so the fix is the smallest one that passes',
      ).toEqual([]);
    });
  }

  // Positive control. With every token fixed, "no failures" is otherwise equally
  // consistent with a parse that returned nothing and a loop that ran zero times.
  it('the parse actually finds the tokens', () => {
    const light = tokensOf(css, '.light {');
    expect(Object.keys(light).length).toBeGreaterThan(10);
    for (const role of [...TEXT_ROLES, ...GROUNDS]) {
      expect(light[role], `--${role}`).toHaveLength(3);
    }
  });

  // Negative control on the measurement itself: known ratios, so a broken
  // luminance formula fails here rather than silently passing everything.
  it('measures a known ratio correctly', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // The value this pass was written for: the shipped --warning on the shipped --bg.
    expect(contrast([197, 142, 24], [245, 247, 252])).toBeCloseTo(2.70, 1);
  });
});
