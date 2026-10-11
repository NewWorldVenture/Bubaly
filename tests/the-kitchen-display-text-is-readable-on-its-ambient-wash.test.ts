import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A11Y-001: the kitchen display (/display) paints a time-of-day gradient
// behind every tile, on by default (`ambient: true`). Its brightest stops,
// pink-300 at dawn, sky-300 in the morning and orange-400 in the evening, put
// the display's white text at 1.7 to 3.7:1, measured from the rendered pixels
// on a seeded household at 390 and 1280 px; most of it was white/50-60. axe
// did not see it: the wash is a fixed -z-10 layer, so axe measured against the
// page's body colour (dark theme: "passes"; light theme: "1.04").
//
// The display's own ink now lies over the wash and its glows, and its body
// text is white/70 or more. This reads all three from the source (the stops
// and glows in lib/display/ambient.ts, the scrim in display-grid.tsx, the
// text and tile alphas in the display's components) and composes them the
// way the browser does, at each theme's brightest point.

const INK = [11, 16, 32]; // #0b1020, the display's ground
const WHITE = [255, 255, 255];

const lum = (c: number[]) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: number[], alpha: number, under: number[]) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const ambient = readFileSync('lib/display/ambient.ts', 'utf8');
const grid = readFileSync('components/display/display-grid.tsx', 'utf8');
const displayFiles = [
  ...readdirSync('components/display').filter((f) => f.endsWith('.tsx')).map((f) => join('components/display', f)),
  'app/(app)/display/page.tsx',
  'app/(app)/display/error.tsx',
];

/** Every colour a theme's wash or glow can put behind a tile. */
function washColours(): number[][] {
  const themes = ambient.slice(ambient.indexOf('dawn:'), ambient.indexOf('aurora:') + 400);
  return [...new Set(themes.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].map(hex);
}
/** The ink laid over the wash, as the scrim element writes it. */
function scrim(): number {
  const m = grid.match(/\{settings\.ambient && <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-\[#0b1020\]\/(\d+)" \/>\}/);
  expect(m, 'the ambient scrim in display-grid.tsx').not.toBeNull();
  return Number(m![1]) / 100;
}
/** Bare (not hover:, placeholder: …) `text-white/NN` in the display's files. */
function textAlphas(): { file: string; alpha: number }[] {
  return displayFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?<![\w:/-])text-white\/(\d+)\b/g)]
    .map((m) => ({ file, alpha: Number(m[1]) / 100 })));
}

describe('the kitchen display’s text is readable on its ambient wash', () => {
  it('reads the wash, the scrim and the text from the source (non-vacuity)', () => {
    const colours = washColours();
    expect(colours.length).toBeGreaterThan(10);
    expect(colours).toContainEqual(hex('#f9a8d4')); // dawn's pink-300
    expect(colours).toContainEqual(hex('#7dd3fc')); // morning's sky-300
    expect(ambient).toMatch(/ambient: true/); // on by default
    expect(scrim()).toBeGreaterThan(0);
    expect(textAlphas().length).toBeGreaterThan(40);
  });

  it('every body text alpha on the display is white/70 or more', () => {
    const faint = textAlphas().filter((t) => t.alpha < 0.7).map((t) => `${t.file} text-white/${Math.round(t.alpha * 100)}`);
    expect(faint).toEqual([]);
  });

  it('at each theme’s brightest point, body text clears 4.5:1 and the full-white button text on its 15% tile clears it too', () => {
    const minText = Math.min(...textAlphas().map((t) => t.alpha));
    const failures: string[] = [];
    for (const colour of washColours()) {
      const ground = over(INK, scrim(), colour);
      // A tile (bg-white/10 at most behind body text) over the scrimmed wash.
      const tile = over(WHITE, 0.10, ground);
      const body = contrast(over(WHITE, minText, tile), tile);
      if (body < 4.5) failures.push(`white/${Math.round(minText * 100)} on a white/10 tile over ${colour}: ${body.toFixed(2)}`);
      const button = over(WHITE, 0.15, ground); // the setup guide button, solid white text
      const solid = contrast(WHITE, button);
      if (solid < 4.5) failures.push(`white on a white/15 button over ${colour}: ${solid.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it('the hints pill reads at 4.5:1 even over the brightest photo pixel', () => {
    // It floats over the wash, the featured recipe's photo and the photo
    // backdrop; at bg-black/45 it read 1.4:1 over a pale photo at 390 px.
    const pill = readFileSync('components/display/hints-ticker.tsx', 'utf8').match(/rounded-full bg-black\/(\d+) [^"]*text-white\/(\d+)/);
    expect(pill, 'the hints pill classes').not.toBeNull();
    const ground = over([0, 0, 0], Number(pill![1]) / 100, WHITE);
    expect(contrast(over(WHITE, Number(pill![2]) / 100, ground), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('without the scrim the same text fails, as measured (the control)', () => {
    const minText = Math.min(...textAlphas().map((t) => t.alpha));
    const worst = Math.min(...washColours().map((c) => { const tile = over(WHITE, 0.10, c); return contrast(over(WHITE, minText, tile), tile); }));
    expect(worst).toBeLessThan(3);
  });
});
