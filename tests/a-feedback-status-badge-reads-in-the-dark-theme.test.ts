import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS_META } from '@/lib/feedback/board';
import type { FeedbackStatus } from '@/lib/feedback/board';

// A11Y-001, WCAG 1.4.3. The feedback board's status badges are a palette
// shade on its own 15% tint. The light theme remaps the shade (the raw
// palette text block in app/globals.css); the dark theme draws it as written.
// The admin console's axe sweep found the In progress badge, purple-500 on
// purple-500/15, at 4.32:1 on the dark page; Planned, blue-500 on its tint,
// read 4.38:1 over --surface. They are purple-400 and blue-400 now (the light
// theme remaps both shades alike); this holds every badge to 4.5:1 on its
// tint over the dark theme's --bg and --surface.

// Tailwind 3.4's shades the badges use.
const HEX: Record<string, string> = {
  'amber-500': 'f59e0b', 'blue-400': '60a5fa', 'blue-500': '3b82f6', 'purple-400': 'c084fc', 'purple-500': 'a855f7',
  'emerald-500': '10b981', 'zinc-400': 'a1a1aa', 'zinc-500': '71717a',
};

type Rgb = [number, number, number];
const fromHex = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The browser rounds each translucent layer to 8 bits, so the reading here does too.
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => Math.round(v * alpha + under[i] * (1 - alpha))) as Rgb;

const css = readFileSync('app/globals.css', 'utf8');
function darkToken(name: string): Rgb {
  const block = css.slice(css.indexOf(':root,\n.dark {'));
  const m = block.match(new RegExp(`--${name}: (\\d+) (\\d+) (\\d+);`));
  expect(m, `--${name} in .dark`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** A badge's text and tint: `bg-<hue>-<shade>/<alpha> text-<hue>-<shade>`. */
function parts(badge: string) {
  const text = badge.match(/(?:^|\s)text-([a-z]+-\d+)(?=\s|$)/);
  const tint = badge.match(/(?:^|\s)bg-([a-z]+-\d+)\/(\d+)(?=\s|$)/);
  expect(text && tint, badge).toBeTruthy();
  return { text: text![1], tint: tint![1], alpha: Number(tint![2]) / 100 };
}

const darkReading = (badge: string) => {
  const { text, tint, alpha } = parts(badge);
  expect(HEX[text], text).toBeTruthy();
  expect(HEX[tint], tint).toBeTruthy();
  return Math.min(...['bg', 'surface'].map((s) => contrast(fromHex(HEX[text]), over(fromHex(HEX[tint]), alpha, darkToken(s)))));
};

describe("the feedback board's status badges in the dark theme", () => {
  it.each(Object.entries(STATUS_META) as [FeedbackStatus, (typeof STATUS_META)[FeedbackStatus]][])('%s reads at 4.5:1 on its own tint', (_status, meta) => {
    expect(darkReading(meta.badge)).toBeGreaterThanOrEqual(4.5);
  });

  it('control: the In progress and Planned badges as they were read under 4.5:1', () => {
    expect(darkReading('bg-purple-500/15 text-purple-500 border-purple-500/25')).toBeLessThan(4.5);
    expect(darkReading('bg-blue-500/15 text-blue-500 border-blue-500/25')).toBeLessThan(4.5);
  });
});
