import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { between, bodyOf } from './helpers/source-order';

// A11Y-001: the command center's readiness label ("On track", "Needs
// attention", "Action required") and its ring were coloured with Tailwind's
// green-500, amber-400 and red-400 as inline hex. Those were picked against
// the dark theme; on the light theme's card they read 2.2, 1.6 and 2.7:1.
// They are the theme's status roles now, which hold 4.5:1 in both themes.

const page = readFileSync('app/(app)/dashboard/command-center/page.tsx', 'utf8');
const css = readFileSync('app/globals.css', 'utf8');

type Rgb = number[];
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: Rgb, alpha: number, under: Rgb) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));

function tokens(selector: string): Record<string, Rgb> {
  const block = bodyOf(css, selector, '\n}');
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

/** The status roles SCORE_TONE gives the label and the ring, in order. */
const roles = () => [...between(page, 'const SCORE_TONE = {', '} as const;')
  .matchAll(/text: 'text-(\w+)', stroke: 'stroke-\1'/g)].map((m) => m[1]);

describe('the readiness score is readable in both themes', () => {
  it('its label and ring take the status roles, not inline hex', () => {
    expect(roles()).toEqual(['success', 'warning', 'danger']);
    expect(page).toContain("<p className={cn('text-lg font-bold', scoreTone.text)}>{scoreLabel}</p>");
    expect(page).toContain('className={scoreTone.stroke}');
    expect(page).not.toMatch(/#22c55e|#fbbf24|#f87171|style=\{\{ color: score/);
  });

  for (const [theme, selector] of [['light', '.light {'], ['dark', '.dark {']] as const) {
    it(`${theme}: each label clears 4.5:1 on the card (bg-surface/40 over --bg)`, () => {
      const t = tokens(selector);
      const card = over(t.surface, 0.4, t.bg);
      const found = roles();
      expect(found).toHaveLength(3);
      for (const role of found) expect(contrast(t[role], card), role).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the hex it replaces did not, in the light theme (control)', () => {
    const t = tokens('.light {');
    const card = over(t.surface, 0.4, t.bg);
    for (const hex of [[34, 197, 94], [251, 191, 36], [248, 113, 113]]) expect(contrast(hex, card)).toBeLessThan(3);
  });
});
