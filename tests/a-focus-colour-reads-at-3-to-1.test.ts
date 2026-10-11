import { readFileSync } from 'node:fs';
import colors from 'tailwindcss/colors';
import { describe, expect, it } from 'vitest';
import { contrast, GROUNDS, over, THEMES, tokensOf } from './helpers/faded-text';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.11 (non-text contrast): a focus indicator reads at 3:1
// against the colours next to it.
//
// Most fields here take the shared focus-ring. About thirty instead write
// their own focus colour: a border that turns `brand/50` (or /40, /60), or a
// `ring-brand/30` glow, on a raw <input>, <select> or <textarea> with the
// outline removed. That colour is the only sign of focus, and at those alphas
// it is 1.3-2.8:1 against the page grounds, in both themes. Full --brand is
// 3.25:1 or better on each. The marketing search, subscribe and FAQ fields used
// violet-400, which is 2.54:1 on the light theme's page even at full strength.
//
// This reads every class string that sets a focus border, ring or outline
// colour and requires at least one of them to reach 3:1 on every ground, or the
// shared focus-ring with no ring colour of its own laid over it. A background
// that changes on focus is not judged here.

const FOCUS_COLOUR = /^(focus|focus-visible|focus-within):(border|ring|outline)-([a-z]+(?:-[a-z]+)*?)(?:-(\d{2,3}))?(?:\/(\d{1,3}))?$/;
const NOT_A_COLOUR = /^(\d+|x|y|t|r|b|l|s|e|inset|offset|none|transparent|current|inherit|dashed|dotted|double|solid|hidden)$/;

/** A focus colour class's [token or palette colour, alpha], or null when it is a width, style or position. */
function colourOf(cls: string, theme: Record<string, number[]>): [number[], number] | null {
  const m = cls.match(FOCUS_COLOUR);
  if (!m) return null;
  const [, , , name, shade, alpha] = m;
  if (NOT_A_COLOUR.test(name) || name.startsWith('offset')) return null;
  const a = alpha ? Number(alpha) / 100 : 1;
  if (!shade && theme[name]) return [theme[name], a];
  const palette = (colors as unknown as Record<string, Record<string, string>>)[name];
  const hex = shade ? palette?.[shade] : undefined;
  if (!hex) return null;
  return [[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), a];
}

/** The worst contrast of a focus colour against the page grounds, in either theme. */
function worst(cls: string): number | null {
  let w = Infinity;
  for (const [, selector] of THEMES) {
    const t = tokensOf(selector);
    const c = colourOf(cls, t);
    if (!c) return null;
    for (const g of [...GROUNDS.map((k) => t[k]), over(t.surface, 0.6, t.bg)]) w = Math.min(w, contrast(over(c[0], c[1], g), g));
  }
  return w;
}

type Site = { at: string; classes: string };

/** Class strings that set a focus colour and none that reads at 3:1. */
function faintFocus(file: string, src: string): Site[] {
  const out: Site[] = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
      const classes = m[2].split(/\s+/);
      const focus = classes.filter((c) => worst(c) !== null);
      if (!focus.length) continue;
      if (focus.some((c) => worst(c)! >= 3)) continue;
      if (classes.includes('focus-ring') && !focus.some((c) => /:ring-/.test(c))) continue;
      out.push({ at: `${file}:${i + 1}`, classes: focus.join(' ') });
    }
  });
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')];
const found = files.flatMap((f) => {
  const src = readFileSync(f, 'utf8');
  return /(focus|focus-visible|focus-within):(border|ring|outline)-/.test(src) ? faintFocus(f, src) : [];
});

describe('a focus colour reads at 3:1', () => {
  it('no field marks focus with a colour under 3:1', () => {
    expect(found.map((s) => `${s.at}: ${s.classes}`)).toEqual([]);
  });

  it('the colours: brand at 30-70% and violet-400 fall short; full brand does not', () => {
    for (const a of [30, 40, 50, 60, 70]) expect(worst(`focus:border-brand/${a}`), `brand/${a}`).toBeLessThan(3);
    expect(worst('focus:border-brand')).toBeGreaterThanOrEqual(3);
    expect(worst('focus-within:border-brand')).toBeGreaterThanOrEqual(3);
    expect(worst('focus-visible:ring-brand')).toBeGreaterThanOrEqual(3);
    expect(worst('focus:border-violet-400')).toBeLessThan(3); // 2.54 on the light page
  });

  it('the scanner: a faint colour is found unless something else on the element reads at 3:1', () => {
    const scan = (cls: string) => faintFocus('p.tsx', `<input className="${cls}" />`).length;
    expect(scan('border border-border outline-none focus:border-brand/50')).toBe(1);
    expect(scan('outline-none focus:ring-2 focus:ring-brand/30')).toBe(1);
    expect(scan('border focus-within:border-violet-400/50')).toBe(1);
    expect(scan('border border-border outline-none focus:border-brand')).toBe(0);
    expect(scan('focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40')).toBe(0); // the border carries it
    expect(scan('focus-ring focus:border-brand/50')).toBe(0); // the shared ring carries it
    expect(scan('focus-ring focus:ring-brand/30')).toBe(1); // ...unless a faint ring colour is laid over it
    expect(scan('focus:ring-2 focus:ring-offset-2')).toBe(0); // widths and offsets are not colours
    expect(scan('rounded-xl border px-3')).toBe(0);
  });
});
