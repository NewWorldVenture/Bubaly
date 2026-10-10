import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

// A11Y-001: the light theme's raw palette text.
//
// The app writes Tailwind's light palette shades straight into class names
// (`text-emerald-400`, `hover:text-rose-300`, …). They were picked against the
// dark theme; on a light surface they read at 1.2 to 2.8:1. app/globals.css
// gives each hue's 200/300/400 shade, and its hover and group-hover forms, a
// darker colour in `.light`. This test reads that block and holds it to two
// things: every such class the source uses has a rule, and every rule's
// colour is readable as text (4.5:1) on the light theme's surfaces and on the
// hue's own pale chip tint.

const css = readFileSync('app/globals.css', 'utf8');
const block = between(css, "/* The light theme's raw palette text (A11Y-001).", "/* End of the light theme's raw palette text. */");

// Tailwind 3.4's 500 shades: the tint a chip puts behind its text (bg-<hue>-500/15).
const TAILWIND_500: Record<string, string> = {
  emerald: '10b981', green: '22c55e', amber: 'f59e0b', yellow: 'eab308', sky: '0ea5e9', blue: '3b82f6', teal: '14b8a6',
  rose: 'f43f5e', red: 'ef4444', orange: 'f97316', lime: '84cc16', cyan: '06b6d4', violet: '8b5cf6', purple: 'a855f7',
  pink: 'ec4899', indigo: '6366f1', fuchsia: 'd946ef',
};

type Rgb = [number, number, number];
const fromHex = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => v * alpha + under[i] * (1 - alpha)) as Rgb;

/** The light theme's surfaces, read from its token block. */
function lightToken(name: string): Rgb {
  const tokens = css.slice(at(css, '.light {'));
  const m = tokens.match(new RegExp(`--${name}: (\\d+) (\\d+) (\\d+);`));
  expect(m, `--${name} in .light`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** hue → the rgb its base rule sets. */
function rules(): Map<string, Rgb> {
  const out = new Map<string, Rgb>();
  for (const m of block.matchAll(/\.light :is\(\.text-([a-z]+)-200,[^{]*\{\s*color: rgb\((\d+) (\d+) (\d+) \/ var\(--tw-text-opacity, 1\)\);/g)) {
    out.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const USED = /(?:^|["'`\s:])((?:hover:|group-hover:)?text-([a-z]+)-(200|300|400)(?:\/(\d+))?)(?=["'`\s]|$)/gm;

describe('the light theme’s palette text is readable', () => {
  it('has a rule for every hue it names (non-vacuity)', () => {
    expect(rules().size).toBe(Object.keys(TAILWIND_500).length);
  });

  it('every rule’s colour keeps 4.5:1 on white, on --bg, on --surface and on its hue’s 500/20 tint', () => {
    const surfaces = { white: [255, 255, 255] as Rgb, bg: lightToken('bg'), surface: lightToken('surface') };
    for (const [hue, rgb] of rules()) {
      const tint = over(fromHex(TAILWIND_500[hue]), 0.2, surfaces.bg);
      for (const [name, under] of Object.entries({ ...surfaces, tint })) {
        expect(contrast(rgb, under), `${hue} on ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('covers every light palette text class the source uses, in every form', () => {
    const missing = new Set<string>();
    const hues = rules();
    for (const file of [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')]) {
      for (const m of readFileSync(file, 'utf8').matchAll(USED)) {
        const [, cls, hue, shade, alpha] = m;
        if (!(hue in TAILWIND_500)) continue;
        if (!hues.has(hue)) { missing.add(`${cls} (${file})`); continue; }
        if (cls.startsWith('hover:') && !block.includes(`.hover\\:text-${hue}-${shade}:hover`)) missing.add(`${cls} (${file})`);
        if (cls.startsWith('group-hover:') && !block.includes(`.group:hover .group-hover\\:text-${hue}-${shade}`)) missing.add(`${cls} (${file})`);
        if (alpha && !block.includes(`.light .text-${hue}-${shade}\\/${alpha}:not(:is(.keep-dark-palette, .marketing-theme, .dark) *)`)) missing.add(`${cls} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('a slash variant keeps its own alpha on the darker colour', () => {
    for (const m of block.matchAll(/\.light \.text-([a-z]+)-\d+\\\/(\d+):not\(:is\(\.keep-dark-palette, \.marketing-theme, \.dark\) \*\) \{ color: rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\); \}/g)) {
      expect(Number(m[6]), m[0]).toBeCloseTo(Number(m[2]) / 100, 5);
      expect([Number(m[3]), Number(m[4]), Number(m[5])], m[0]).toEqual(rules().get(m[1]));
    }
  });

  it('applies only in the signed-in app’s light theme: never on marketing pages, in a forced-dark subtree or on a surface marked to keep the original shades', () => {
    for (const rule of block.match(/^\.light [^{]+\{/gm) ?? []) {
      expect(rule).toMatch(/:not\(:is\(\.keep-dark-palette, \.marketing-theme, \.dark\) \*\) \{$/);
    }
    expect(block).not.toMatch(/^\.dark /m);
  });
});
