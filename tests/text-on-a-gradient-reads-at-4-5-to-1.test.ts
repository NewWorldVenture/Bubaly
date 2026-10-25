import colors from 'tailwindcss/colors';
import { describe, expect, it } from 'vitest';
import { contrast, scanFiles, scanSource, THEMES, tokensOf, type Site } from './helpers/faded-text';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.3: text laid on a gradient reads at 4.5:1 against every
// colour the gradient passes through, at rest and hovered.
//
// The site's call-to-action gradient ran from blue-500 to violet-600. White on
// blue-500 is 3.68:1; measured along each button's text, the marketing CTAs
// read 3.90-4.44:1, and the header's "Get Started Free" 4.07:1. Five of them
// (the security page's three, the blog's subscribe button) set no text colour
// and took the page's: dark ink on the violet end, 3.03:1 in the light theme,
// and the dark theme's near-white, 3.38:1. On hover most lightened further,
// with `brightness-110`, or faded, with `opacity-90`. The gradient now starts
// at blue-600 (white 5.17:1), each one names its text colour, and hover
// darkens (`brightness-95`). In the app, the weekly briefing's emerald-600 to
// teal-600 button (white 3.74:1) moves to the 700 shades, and it and the
// briefing button darken on hover instead of lightening to the 500s (2.49:1
// and 4.23:1); the how-it-works step numbers take white on violet-600.
//
// This reads every text-bearing element painted with a gradient and requires
// a text colour of its own that reads at 4.5:1 against each stop, in both
// themes, including the stops and brightness it takes on hover. Between theme
// grounds (`from-elevated to-surface`) the page's own ink is the one made for
// them. Text in a child that paints its own fill (a tooltip, a badge) is that
// child's, and text marked aria-hidden is decoration. A gradient whose stops
// are translucent is a tint over whatever lies beneath, and is not judged here.

const STOP = /^(hover:)?(from|via|to)-(.+)$/;
const TEXT = /^text-(.+)$/;
const NOT_A_TEXT_COLOUR = /^(xs|sm|base|lg|xl|\dxl|\[\d|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)/;
const BRIGHTNESS = /^hover:brightness-(\d+)$/;
const TOKENS = tokensOf('.dark {');

/** A colour class's value — a theme token, a palette shade or an arbitrary hex — per theme, or null when it is translucent or unknown. */
function colourOf(name: string, theme: Record<string, number[]>): number[] | null {
  if (name.includes('/')) return null;
  if (name === 'white') return [255, 255, 255];
  if (name === 'black') return [0, 0, 0];
  const hex = /^\[#([0-9a-f]{6})\]$/i.exec(name)?.[1];
  if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (theme[name]) return theme[name];
  const m = /^([a-z]+)-(\d{2,3})$/.exec(name);
  const value = m && (colors as unknown as Record<string, Record<string, string>>)[m[1]]?.[m[2]];
  return value ? [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) : null;
}

/** Text on a gradient that inherits its ink, fades on hover, or reads under 4.5:1 against a stop: one line per element. */
function unreadableOnGradient(sites: Site[]): string[] {
  const out: string[] = [];
  for (const s of sites) {
    if (!s.ownText || s.exempt || !s.classes.some((c) => /^bg-gradient-to-/.test(c))) continue;
    const stops = s.classes.filter((c) => STOP.test(c));
    if (!stops.length || stops.some((c) => c.includes('/'))) continue; // a translucent tint, not a fill
    const own = s.classes.filter((c) => TEXT.test(c) && !NOT_A_TEXT_COLOUR.test(c.slice(5)));
    const onGrounds = stops.every((c) => STOP.exec(c)![3] in TOKENS);
    if (!own.length && !onGrounds) { out.push(`${s.at}: inherits its text colour`); continue; }
    const inks = own.length ? own : ['text-fg'];
    if (s.classes.some((c) => /^hover:opacity-\d+$/.test(c))) out.push(`${s.at}: fades its text on hover`);
    // A hover brightness filter scales every sRGB channel of the element, its text as well as its fill.
    const factor = Number(s.classes.map((c) => BRIGHTNESS.exec(c)?.[1]).find(Boolean) ?? 100) / 100;
    const lit = (c: number[]) => c.map((v) => Math.min(255, Math.round(v * factor)));
    let worst = { ratio: Infinity, why: '' };
    for (const [theme, selector] of THEMES) {
      const t = tokensOf(selector);
      for (const ink of inks) {
        const fg = colourOf(ink.slice(5), t);
        for (const stop of stops) {
          const [, hover, , name] = STOP.exec(stop)!;
          const c = colourOf(name, t);
          if (!fg || !c) continue;
          const states: [string, number[], number[]][] = hover ? [['hovered', lit(fg), lit(c)]] : [['at rest', fg, c], ['hovered', lit(fg), lit(c)]];
          for (const [state, front, back] of states) {
            const ratio = contrast(front, back);
            if (ratio < worst.ratio) worst = { ratio, why: `${theme}, ${state}: ${ink} on ${stop}` };
          }
        }
      }
    }
    if (worst.ratio < 4.5) out.push(`${s.at}: ${worst.why} ${worst.ratio.toFixed(2)}:1`);
  }
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('text on a gradient reads at 4.5:1', () => {
  it('no text-bearing gradient inherits its ink or reads under 4.5:1 against a stop', () => {
    expect(unreadableOnGradient(scanFiles(files, /bg-gradient-to-/))).toEqual([]);
  });

  it('the CTA gradient starts at blue-600, which white reads on at 4.5:1; blue-500 does not', () => {
    const white = [255, 255, 255];
    expect(contrast(white, colourOf('blue-600', {})!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(white, colourOf('violet-600', {})!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(white, colourOf('blue-500', {})!)).toBeLessThan(4.5);
    expect(contrast(white, colourOf('blue-600', {})!.map((v) => Math.min(255, Math.round(v * 1.1))))).toBeLessThan(4.5);
  });

  it('the scanner: inherited ink, a faint stop, a lightening or fading hover are found; a dark fill with its own ink is not', () => {
    const scan = (cls: string) => unreadableOnGradient(scanSource('p.tsx', `export const P = () => <a className="${cls}">Start</a>;`)).length;
    expect(scan('bg-gradient-to-r from-blue-500 to-violet-600 text-brand-fg')).toBeGreaterThan(0);
    expect(scan('bg-gradient-to-r from-blue-600 to-violet-600 text-sm font-bold')).toBe(1); // no ink of its own
    expect(scan('bg-gradient-to-r from-blue-600 to-violet-600 text-brand-fg hover:brightness-110')).toBeGreaterThan(0);
    expect(scan('bg-gradient-to-r from-blue-600 to-violet-600 text-brand-fg hover:opacity-90')).toBe(1);
    expect(scan('bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-500 text-white')).toBeGreaterThan(0);
    expect(scan('bg-gradient-to-r from-blue-600 to-violet-600 text-brand-fg hover:brightness-95')).toBe(0);
    expect(scan('bg-gradient-to-r from-[#435df0] to-[#7834e9] text-sm text-brand-fg')).toBe(0);
    expect(scan('bg-gradient-to-br from-violet-500/40 via-blue-500/25 to-emerald-500/30')).toBe(0); // a tint
    expect(scan('bg-gradient-to-br from-elevated to-surface')).toBe(0); // theme grounds, the page's own ink
    expect(scan('bg-gradient-to-br from-elevated to-surface text-muted/40')).toBe(0); // a translucent ink is the faded-text guards'
    expect(unreadableOnGradient(scanSource('p.tsx', 'export const P = () => <div className="bg-gradient-to-r from-blue-500 to-violet-600" />;'))).toEqual([]); // no text
    // A tooltip inside a gradient button paints its own fill: its words are not on the gradient.
    expect(unreadableOnGradient(scanSource('p.tsx', 'export const P = () => <button className="bg-gradient-to-r from-violet-500 to-blue-600 text-white"><span className="bg-surface text-fg">Ask</span></button>;'))).toEqual([]);
    expect(unreadableOnGradient(scanSource('p.tsx', 'export const P = () => <button className="bg-gradient-to-r from-violet-500 to-blue-600 text-white"><span className="font-bold">Ask</span></button>;'))).toHaveLength(1);
    expect(unreadableOnGradient(scanSource('p.tsx', 'export const P = () => <div className="bg-gradient-to-r from-blue-500 to-violet-600"><span aria-hidden>🍝</span></div>;'))).toEqual([]);
  });
});
