import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, cssVarName, tokens } from '@/design/tokens';

// Two interlocked defects the browser pass found (audit C2-B01 / C2-B04), and
// the guard that can actually go red for them.
//
// C2-B01: `.focus-ring` was a plain component class, so it compiled to an
// UNCONDITIONAL ring — the brand ring painted permanently on all 202 elements
// carrying it, plus `outline: 2px solid transparent` suppressing the browser's
// own outline. Focusing an element changed its computed style by zero bytes.
// WCAG 2.4.7 failed not by omission but by an indicator that was never OFF.
//
// C2-B04: text inputs took `border-border`, which is 1.28:1 (light) / 1.38:1
// (dark) against the surface behind them, while the control fill is identical
// to that surface (1.00:1). The border was a field's only boundary and it was
// under WCAG 1.4.11's 3:1 — visible today ONLY because C2-B01's permanent ring
// outlined every field. Fixing focus alone would have left the inputs with no
// visible edge at all, which is why the two land together.
//
// Neither was visible to `next lint`, to axe, or to any test here: no static
// rule describes "this class should have been a state variant", and nothing in
// this repository had ever computed a contrast ratio.

const globals = readFileSync(resolve('app/globals.css'), 'utf8');

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: readonly number[]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.x contrast ratio, 1:1 … 21:1. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The body of the FIRST rule whose selector matches exactly. */
function rule(selector: string): string | null {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.:\\-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(globals);
  return m ? m[2] : null;
}

const RING = /\bring-2\b|\bring-brand\b|\bring-offset/;

describe('the focus ring can turn off (C2-B01)', () => {
  it('.focus-ring paints no ring on its own', () => {
    const body = rule('.focus-ring');
    expect(body, '.focus-ring rule missing from app/globals.css').not.toBeNull();
    // This is the assertion that would have caught the original defect: the
    // unconditional rule carried `ring-2 ring-brand/60 ring-offset-2`.
    expect(body).not.toMatch(RING);
  });

  it('.focus-ring:focus-visible is what paints it', () => {
    const body = rule('.focus-ring:focus-visible');
    expect(body, '.focus-ring:focus-visible rule missing — the ring would never appear').not.toBeNull();
    expect(body).toMatch(RING);
  });

  it('no call site carries the focus-visible: prefix that existed to work around it', () => {
    // Harmless but misleading now that the class is state-scoped: it says the
    // call site is doing work the class already does.
    const sources = [resolve('app'), resolve('components')];
    const hits: string[] = [];
    for (const dir of sources) walk(dir, hits);
    expect(hits).toEqual([]);
  });
});

describe('form controls have a visible boundary (C2-B04)', () => {
  const surfaces = ['surface', 'bg'] as const;

  for (const mode of ['dark', 'light'] as const) {
    it(`--border-input clears WCAG 1.4.11's 3:1 in ${mode}`, () => {
      const border = tokens.colors[mode].borderInput;
      for (const against of surfaces) {
        const ratio = contrast(border, tokens.colors[mode][against]);
        expect(ratio, `${mode}: --border-input on --${against} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('the Input primitive uses it rather than the general --border', () => {
    const input = readFileSync(resolve('components/ui/input.tsx'), 'utf8');
    const base = /const base =\s*\n?\s*'([^']*)'/.exec(input);
    expect(base, 'could not find the shared `base` class string').not.toBeNull();
    expect(base![1]).toContain('border-input');
    // `border-border` here is the 1.28:1 boundary the finding is about.
    expect(base![1]).not.toMatch(/\bborder-border\b/);
  });

  it('--border-input is declared in both themes and matches the shared token file', () => {
    expect(globals.match(/--border-input:/g), 'expected one declaration per theme').toHaveLength(2);
    expect(COLOR_TOKENS).toContain('borderInput');
    expect(cssVarName('borderInput')).toBe('--border-input');
  });
});

// Kept last: a plain directory walk, so the assertion above reads cleanly.
function walk(dir: string, hits: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, hits);
    else if (extname(entry.name) === '.tsx' && readFileSync(path, 'utf8').includes('focus-visible:focus-ring')) hits.push(path);
  }
}
