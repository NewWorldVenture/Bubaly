import { readdirSync, readFileSync } from 'node:fs';
import { join as nativeJoin } from 'node:path';
const join = (...parts: string[]): string => nativeJoin(...parts).replace(/\\/g, '/');
import { describe, expect, it } from 'vitest';
import {
  animationTrough, contrast, hex, INK, mountChains, opaque, over, readJsx, scrimAlpha, STATES, unresolved, washColours, worstReading,
  type Node, type Rgb,
} from './helpers/display-surfaces';

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
//
// The first version composed each text over ONE surface. The audit of it
// (PR #1006) found what that misses: the timer picker's duration was white/70
// on a white/10 button, white/20 hovered, inside the grid's white/6 tile
// (4.27:1 idle, 3.43:1 hovered on the morning stop), and the setup guide's
// label was white on white/15, white/25 hovered, inside its own white/7 card
// (5.72:1, 4.41:1). The cases from "the layers" on read each text's parents
// from the JSX (tests/helpers/display-surfaces.ts) and compose every one of
// them, idle, hovered, focused and at an animation's faintest frame.
//
// These are ARITHMETIC: alpha compositing and WCAG luminance on the class
// values, with every wash colour taken as if it lay under every tile. They
// leave out the page's own tint (body::before in app/globals.css, brand/0.16
// and accent/0.10 in radial gradients centred off-screen at the top right and
// bottom left). tests/e2e/the-kitchen-display-text-is-readable-on-its-ambient-wash.spec.ts
// measures the same controls in Chromium's rendered pixels, tint included.

const ambient = readFileSync('lib/display/ambient.ts', 'utf8');
const grid = readFileSync('components/display/display-grid.tsx', 'utf8');
const displayFiles = [
  ...readdirSync('components/display').filter((f) => f.endsWith('.tsx')).map((f) => join('components/display', f)),
  'app/(app)/display/page.tsx',
  'app/(app)/display/error.tsx',
];
const WHITE = [255, 255, 255];

/** The ink laid over the wash, as the scrim element writes it. */
function scrim(): number {
  const alpha = scrimAlpha(grid);
  expect(alpha, 'the ambient scrim in display-grid.tsx').not.toBeNull();
  return alpha!;
}
/** Bare (not hover:, placeholder: …) `text-white/NN` in the display's files. */
function textAlphas(): { file: string; alpha: number }[] {
  return displayFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?<![\w:/-])text-white\/(\d+)\b/g)]
    .map((m) => ({ file, alpha: Number(m[1]) / 100 })));
}

// ── The layers ───────────────────────────────────────────────────────────────

/** The component every tile, card and strip on the wash is mounted under. */
const ROOT = 'DisplayShell';
/**
 * Text over photographs: the photo backdrop, the photo frame and the featured
 * recipe's photo. Their contrast depends on the picture, the separately
 * acknowledged open scope of A11Y-001; none of them is on the wash.
 */
const OVER_PHOTOS = ['PhotoBackdrop', 'PhotoFrame', 'FeaturedWidget'];
/** Text in the display's files that is neither on the wash nor on a screen of its own, and why. */
const ELSEWHERE: Record<string, string> = {
  DisplaySelfCheck: 'the /display/setup page, on the app theme, not the wash',
  DisplayClock: 'mounted nowhere (the display uses AmbientClock)',
  '': 'module-level JSX: KIOSK_FALLBACK, a widget boundary\'s fallback',
};

const read = (overrides: Record<string, string> = {}): Node[] =>
  displayFiles.flatMap((file) => readJsx(file, overrides[file] ?? readFileSync(file, 'utf8')));

/** Each composed rendering of a text: the chain of elements under it and the grounds beneath that. */
function placements(node: Node, all: Node[]): { chain: Node[]; grounds: Rgb[] }[] {
  const onWash = mountChains(node, all, ROOT).filter((chain) => !chain.some((n) => OVER_PHOTOS.includes(n.component)));
  if (onWash.length) return onWash.map((chain) => ({ chain, grounds: washColours(ambient).map((c) => over(INK, scrim(), c)) }));
  // A screen of its own (loading, reconnecting, the error boundary): it paints
  // its ground opaque, so what is under it does not matter.
  const local: Node[] = [];
  for (let p: Node | null = node; p; p = p.parent) local.unshift(p);
  return local.length && opaque(local[0]) ? [{ chain: local, grounds: [INK] }] : [];
}

type Finding = { at: string; state: string; ratio: number; layers: string[] };

/** The worst reading of one text in one state, over every place it is mounted. */
function reading(node: Node, all: Node[], state: string): Finding {
  let worst: Finding = { at: `${node.file}:${node.line}`, state, ratio: Infinity, layers: [] };
  for (const { chain, grounds } of placements(node, all)) {
    const r = worstReading(chain, STATES[state], grounds);
    if (r.ratio < worst.ratio) worst = { ...worst, ratio: r.ratio, layers: r.layers };
  }
  return worst;
}

const find = (all: Node[], file: string, says: string): Node => {
  const hits = all.filter((n) => n.file === file && n.says.includes(says));
  expect(hits.map((n) => `${n.file}:${n.line}`), `exactly one text saying ${says} in ${file}`).toHaveLength(1);
  return hits[0];
};
const TIMERS = 'components/display/kitchen-timers.tsx';
const SETUP = 'components/display/setup-card.tsx';
const LOADING = 'components/display/display-shell-client.tsx';
const duration = (all: Node[]) => find(all, TIMERS, '{formatDuration(p.seconds)}');
const guide = (all: Node[]) => find(all, SETUP, "t('displaySetupCard.openTheGuide')");
const fill = (n: Node) => [...new Set(n.variants.flatMap((v) => v.classes).filter((c) => /^(hover:)?bg-white\//.test(c)))];

describe('the kitchen display’s text is readable on its ambient wash', () => {
  it('reads the wash, the scrim and the text from the source (non-vacuity)', () => {
    const colours = washColours(ambient);
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
    // One surface at a time; "the layers" below compose the real stack.
    const minText = Math.min(...textAlphas().map((t) => t.alpha));
    const failures: string[] = [];
    for (const colour of washColours(ambient)) {
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
    const worst = Math.min(...washColours(ambient).map((c) => { const tile = over(WHITE, 0.10, c); return contrast(over(WHITE, minText, tile), tile); }));
    expect(worst).toBeLessThan(3);
  });
});

describe('the layers: each text composed through every surface the display paints under it', () => {
  it('derives the timer picker’s and the setup guide’s parents from the JSX, not from a guess', () => {
    const all = read();
    // The duration sits in a preset button, in KitchenTimers, mounted by
    // WidgetBody inside a grid tile's <section>.
    const timers = mountChains(duration(all), all, ROOT);
    expect(timers.length).toBeGreaterThan(0);
    for (const chain of timers) {
      const tile = chain.find((n) => n.file.endsWith('display-grid.tsx') && n.tag === 'section');
      expect(tile && fill(tile), 'the grid tile under the timers').toEqual(['bg-white/[0.06]']);
      expect(chain.map((n) => n.component)).toEqual(expect.arrayContaining(['OwnedDisplayShell', 'WidgetBody', 'KitchenTimers']));
      const button = chain.at(-2)!;
      expect(button.tag).toBe('button');
      expect(fill(button)).toEqual(['bg-white/10', 'hover:bg-white/20']);
    }
    // The guide is in the setup card, which the shell mounts above the grid,
    // outside every tile: its ground is its own white/7 card.
    const guides = mountChains(guide(all), all, ROOT);
    expect(guides.length).toBeGreaterThan(0);
    for (const chain of guides) {
      expect(chain.some((n) => n.file.endsWith('display-grid.tsx') && n.tag === 'section')).toBe(false);
      expect(chain.map((n) => n.component)).toEqual(expect.arrayContaining(['OwnedDisplayShell', 'DisplaySetupCard']));
      const card = chain.find((n) => n.file === SETUP && n.tag === 'section');
      expect(card && fill(card), 'the setup card under the guide').toEqual(['bg-white/[0.07]']);
      expect(fill(chain.at(-1)!)).toEqual(['bg-white/15', 'hover:bg-white/20']);
    }
  });

  it('the classes before this fix give the audit’s numbers, and fail (the control)', () => {
    // Source-derived bounds, as the audit said: arithmetic on the classes.
    const before = read({
      [TIMERS]: readFileSync(TIMERS, 'utf8').replace('text-[10px] text-white">{formatDuration', 'text-[10px] text-white/70">{formatDuration'),
      [SETUP]: readFileSync(SETUP, 'utf8').replace('text-white transition hover:bg-white/20', 'text-white transition hover:bg-white/25'),
    });
    const at = (node: Node, state: string) => Number(reading(node, before, state).ratio.toFixed(2));
    expect([at(duration(before), 'idle'), at(duration(before), 'hovered')]).toEqual([4.27, 3.43]);
    expect([at(guide(before), 'idle'), at(guide(before), 'hovered')]).toEqual([5.72, 4.41]);
  });

  it('the timer picker’s duration and the setup guide’s label clear 4.5:1 idle and hovered, at every stop', () => {
    const all = read();
    const readings = [duration(all), guide(all)].flatMap((n) => ['idle', 'hovered'].map((s) => reading(n, all, s)));
    const low = readings.filter((r) => r.ratio < 4.5);
    expect(low.map((r) => `${r.at} ${r.state} ${r.ratio.toFixed(2)}: ${r.layers.join(' > ')}`)).toEqual([]);
    expect(readings).toHaveLength(4);
  });

  it('an animation is composed at its faintest frame: white/70 under animate-pulse is not white/70', () => {
    // Tailwind's pulse returns to half opacity every two seconds; an entrance
    // (fade-in) passes 0 once and rests on its last frame.
    expect(animationTrough('pulse')).toBe(0.5);
    expect(animationTrough('fade-in')).toBe(1);
    const source = readFileSync(LOADING, 'utf8');
    const loading = find(read(), LOADING, "t('displayShellClient.bubalyKitchen')");
    expect(loading.variants[0].classes).toContain('animate-pulse');
    const all = read();
    expect(reading(loading, all, 'faintest frame').ratio).toBeGreaterThanOrEqual(4.5);
    // The control: the class alone said white/70, a pass at rest, and at the
    // faintest frame it is white/35.
    const was = read({ [LOADING]: source.replace('tracking-[0.25em] text-white"', 'tracking-[0.25em] text-white/70"') });
    const old = find(was, LOADING, "t('displayShellClient.bubalyKitchen')");
    expect(reading(old, was, 'idle').ratio).toBeGreaterThanOrEqual(4.5);
    expect(reading(old, was, 'faintest frame').ratio).toBeLessThan(4.5);
  });

  it('a finished timer flashes a layer under its words, not the words', () => {
    const all = read();
    const label = find(all, TIMERS, '{t.label}');
    const done = find(all, TIMERS, "{t.done ? tr('kitchenTimers.done') : formatDuration(remaining)}");
    for (const node of [label, done]) {
      for (const chain of mountChains(node, all, ROOT)) {
        expect(chain.flatMap((n) => n.variants.flatMap((v) => v.classes)), 'nothing under the words pulses').not.toContain('animate-pulse');
      }
      expect(reading(node, all, 'faintest frame').ratio).toBeGreaterThanOrEqual(4.5);
      expect(reading(node, all, 'idle').ratio).toBeGreaterThanOrEqual(4.5);
    }
    // The control: the whole card pulsing, as it did.
    const was = read({
      [TIMERS]: readFileSync(TIMERS, 'utf8').replace("t.done ? 'ring-1 ring-emerald-300/60' : 'bg-white/10'", "'bg-white/10', t.done && 'animate-pulse bg-emerald-400/25 ring-1 ring-emerald-300/60'"),
    });
    expect(reading(find(was, TIMERS, '{t.label}'), was, 'faintest frame').ratio).toBeLessThan(4.5);
  });

  it('every text on the display clears 4.5:1 through every surface under it, idle, hovered, focused and at an animation’s faintest frame', () => {
    unresolved.clear();
    const all = read();
    const texts = all.filter((n) => n.text);
    const findings: Finding[] = [];
    const elsewhere = new Set<string>();
    let composed = 0;
    for (const node of texts) {
      if (!placements(node, all).length) {
        if (!mountChains(node, all, ROOT).length) elsewhere.add(node.component);
        continue;
      }
      composed++;
      for (const state of Object.keys(STATES)) findings.push(reading(node, all, state));
    }
    const low = findings.filter((f) => f.ratio < 4.5);
    expect(low.map((r) => `${r.at} ${r.state} ${r.ratio.toFixed(2)}: ${r.layers.join(' > ')}`)).toEqual([]);
    // Every colour class on the way resolved to a value; none was skipped.
    expect([...unresolved]).toEqual([]);
    // What was not composed is accounted for, and it is not most of the display.
    expect([...elsewhere].filter((c) => !(c in ELSEWHERE))).toEqual([]);
    expect(composed).toBeGreaterThan(60);
    expect(findings.length).toBe(composed * Object.keys(STATES).length);
    // The photo surfaces are named, so the exclusion cannot be stale.
    for (const name of OVER_PHOTOS) expect(all.some((n) => n.component === name), name).toBe(true);
  });
});
