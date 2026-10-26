import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, GROUNDS, over, THEMES, tokensOf } from './helpers/faded-text';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.3: a button's text reads at 4.5:1 while it is hovered too.
//
// The shared Button's and ButtonLink's primary variants, .btn-cta and 134
// inline brand buttons faded on hover: 50 with `hover:opacity-90`, which fades
// the white label and the --brand fill together towards whatever is behind
// them, and 84 with `hover:bg-brand/90`, which fades the fill alone. In the
// light theme either took the label from 5.04:1 to 4.21-4.22:1 (measured from
// pixels on --bg, --surface and --elevated). They darken instead, with
// `hover:brightness-95`: the browser multiplies each sRGB channel by 0.95,
// label and fill alike, which reads 4.90:1 in the light theme and 5.21:1 in
// the dark one.
//
// A solid brand fill that fades on hover, through opacity or a translucent
// brand background, is refused wherever it is written.

const FADES = /^hover:(opacity-(\d{1,2})|bg-brand\/\d{1,2})$/;

/** Class strings that fill with solid --brand and fade on hover. */
function fadingBrandButtons(file: string, src: string): string[] {
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
      const classes = m[2].split(/\s+/);
      if (classes.includes('bg-brand') && classes.some((c) => FADES.test(c))) out.push(`${file}:${i + 1}: ${m[2].slice(0, 120)}`);
    }
  });
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('a brand button keeps its text readable on hover', () => {
  it('no solid brand button fades on hover, in a component or in the stylesheet', () => {
    expect(files.flatMap((f) => fadingBrandButtons(f, readFileSync(f, 'utf8')))).toEqual([]);
    const css = readFileSync('app/globals.css', 'utf8');
    const ctas = [...css.matchAll(/@apply ([^;]*\bbg-brand\b[^;]*);/g)].map((m) => m[1]);
    expect(ctas.length).toBeGreaterThan(0);
    for (const rule of ctas) expect(rule.split(/\s+/).some((c) => FADES.test(c)), rule.slice(0, 120)).toBe(false);
  });

  it('the shared Button, ButtonLink and .btn-cta darken on hover', () => {
    for (const f of ['components/ui/button.tsx', 'components/ui/button-link.tsx']) {
      expect(readFileSync(f, 'utf8'), f).toContain("'bg-brand text-brand-fg hover:brightness-95 shadow-glow disabled:shadow-none'");
    }
    expect(readFileSync('app/globals.css', 'utf8')).toMatch(/\.btn-cta \{\s*@apply [^;]*bg-brand [^;]*text-brand-fg [^;]*hover:brightness-95/);
  });

  for (const [theme, selector] of THEMES) {
    it(`${theme}: the label reads at 4.5:1 at rest and darkened; faded to 90% it does not in the light theme`, () => {
      const t = tokensOf(selector);
      const dim = (c: number[]) => c.map((v) => Math.round(v * 0.95));
      expect(contrast(t['brand-fg'], t.brand), 'at rest').toBeGreaterThanOrEqual(4.5);
      expect(contrast(dim(t['brand-fg']), dim(t.brand)), 'hover:brightness-95').toBeGreaterThanOrEqual(4.5);
      const faded = Math.min(...GROUNDS.map((g) => contrast(over(t['brand-fg'], 0.9, t[g]), over(t.brand, 0.9, t[g]))));
      if (theme === 'light') expect(faded, 'control: hover:opacity-90').toBeLessThan(4.5);
    });
  }

  it('the scanner: a brand fill with an opacity or translucent-brand hover is found; a darkening one is not', () => {
    const scan = (cls: string) => fadingBrandButtons('p.tsx', `<button className="${cls}">Save</button>`).length;
    expect(scan('bg-brand text-brand-fg hover:opacity-90')).toBe(1);
    expect(scan('bg-brand text-white hover:bg-brand/90')).toBe(1);
    expect(scan('bg-brand text-brand-fg hover:brightness-95')).toBe(0);
    expect(scan('bg-brand/10 text-brand-text hover:opacity-90')).toBe(0); // a tint, not a fill
    expect(scan('rounded-xl hover:opacity-90')).toBe(0);
  });
});
