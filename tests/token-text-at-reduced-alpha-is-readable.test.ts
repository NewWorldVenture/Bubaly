import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';
import { alphaText, contrast, GROUNDS, over, scanFiles, scanSource, THEMES, tokensOf, worstOnGround } from './helpers/faded-text';

// A11Y-001: a theme colour at reduced alpha (`text-brand-text/70`) is the
// same fade as `opacity-70`, only through the colour. 110 elements that
// render text are painted that way. Most are --fg at 70–90%, which still
// reads 6:1 or better; nine were below 4.5:1 on a plain page:
//   - "Tonight's dinner" (kitchen) and "Total family balance" (treasury),
//     brand-text at 70% on their brand-tinted hero: 3.12:1;
//   - the reply preview's sender, brand-text at 80%: 4.29;
//   - the super-admin "Admin (code)" badge, brand-text at 80%: 4.16;
//   - four in the sidebar, left as they are (see ALLOWED).
// Those four are drawn at full strength now.
//
// The scanner, and what it does and does not read (same-file const aliases
// yes; imports and functions no), is tests/helpers/faded-text.ts.

const ALLOWED: { file: string; has: string; why: string }[] = [
  { file: 'components/app/app-shell.tsx', has: 'text-muted/70', why: 'the sidebar’s group headings: the sidebar is not changed here' },
  { file: 'components/app/free-tier-sidebar.tsx', has: 'text-muted/80', why: 'the free-tier sidebar’s group headings: not changed here' },
  { file: 'components/app/free-tier-sidebar.tsx', has: 'text-muted/50', why: 'the free-tier sidebar’s counts and locked items: not changed here' },
  { file: 'components/app/nav-shared.tsx', has: 'text-muted/45', why: 'a locked (upgrade) nav item: not changed here' },
  { file: 'components/concierge/plan-write-backs.tsx', has: 'disabled={disabled}', why: 'an unavailable write-back: the faint style is applied only when !o.available, which also sets disabled' },
];

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('token text at reduced alpha reads at 4.5:1', () => {
  it('finds it in the source (non-vacuity), and nothing below 4.5:1 on a plain ground but the allowed sites', () => {
    const found = alphaText(scanFiles(files, /text-(muted|fg|brand-text|brand|danger|success|warning|accent)\/\d/));
    expect(found.length).toBeGreaterThan(50);
    expect(found.some((f) => f.token === 'fg' && f.alpha === 0.8)).toBe(true);
    const below = found.filter((f) => worstOnGround(f.token, f.alpha) < 4.5);
    const allowed = (f: (typeof found)[number]) => ALLOWED.some((a) => f.file === a.file && f.line.includes(a.has));
    expect(below.filter((f) => !allowed(f)).map((f) => `${f.at} text-${f.token}/${Math.round(f.alpha * 100)} ${worstOnGround(f.token, f.alpha).toFixed(2)}: ${f.line.slice(0, 160)}`)).toEqual([]);
    for (const a of ALLOWED) expect(below.some((f) => f.file === a.file && f.line.includes(a.has)), `${a.file} ${a.has}`).toBe(true);
  });

  // Through the real scanner: is this brand-text/70 label found?
  const flagged = (body: string, prelude = '') =>
    alphaText(scanSource('fixture.tsx', `${prelude}\nexport function P({ pending, hidden, k }: any) { return (${body}); }`)).length === 1;

  it('exempts only an element that is certainly inactive or hidden; scans false and dynamic states', () => {
    expect(flagged(`<p disabled className="text-brand-text/70">Total</p>`)).toBe(false);
    expect(flagged(`<p disabled={true} className="text-brand-text/70">Total</p>`)).toBe(false);
    expect(flagged(`<p aria-hidden className="text-brand-text/70">Total</p>`)).toBe(false);
    expect(flagged(`<p aria-hidden="true" className="text-brand-text/70">Total</p>`)).toBe(false);
    expect(flagged(`<p disabled={false} className="text-brand-text/70">Total</p>`)).toBe(true);
    expect(flagged(`<p disabled={pending} className="text-brand-text/70">Total</p>`)).toBe(true);
    expect(flagged(`<p aria-hidden={false} className="text-brand-text/70">Total</p>`)).toBe(true);
    expect(flagged(`<p aria-hidden={hidden} className="text-brand-text/70">Total</p>`)).toBe(true);
    expect(flagged(`<p className="cursor-not-allowed text-brand-text/70">Total</p>`)).toBe(true);
    expect(flagged(`<p className="placeholder:text-muted/50 hover:text-brand-text/70">Total</p>`)).toBe(false);
    expect(flagged(`<p className={HERO}>Total</p>`, `const HERO = 'text-xs text-brand-text/70';`)).toBe(true);
    expect(flagged(`<p className={TONE[k]}>Total</p>`, `const TONE = { hero: 'text-brand-text/70' };`)).toBe(true);
    expect(flagged(`<p className={HERO}>Total</p>`, `import { HERO } from './hero';`)).toBe(false);
  });

  it('a fade --fg can afford (70% or more) passes; the ones fixed here did not', () => {
    expect(worstOnGround('fg', 0.7)).toBeGreaterThanOrEqual(4.5);
    expect(worstOnGround('brand-text', 0.7)).toBeLessThan(4.5);
    expect(worstOnGround('brand-text', 0.8)).toBeLessThan(4.5);
    expect(worstOnGround('brand-text', 1)).toBeGreaterThanOrEqual(4.5);
  });

  for (const [theme, selector] of THEMES) {
    it(`${theme}: the hero labels and the reply sender, on their own tints`, () => {
      const t = tokensOf(selector);
      for (const g of GROUNDS) {
        const hero = over(t.brand, 0.1, t[g]); // from-brand/10, the gradient's strongest stop
        const reply = over(t.elevated, 0.6, t[g]); // the reply preview's bg-elevated/60
        expect(contrast(over(t['brand-text'], 0.7, hero), hero), `control: hero at 70% over --${g}`).toBeLessThan(4.5);
        expect(contrast(t['brand-text'], hero), `hero over --${g}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t['brand-text'], reply), `reply over --${g}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// The trust matrix: for a manager each cell is a button that cycles the
// member's permission. A role default was drawn faint, an override in full:
// the deny ✕ at --muted 40% (1.76:1), the allow ✓ at green 50% and the
// approval "~" at amber 60% (light theme, 2.3 and 3.5). A default and an
// override already differ by their background and border, so the default is
// drawn in full colour too. The cell's hover was brightness(1.25), which
// lifts the ink but not the page behind a tint (measured on the calendar
// chips in #1009); it is a shadow now.
describe('a trust-matrix default reads as clearly as an override', () => {
  const trust = readFileSync('components/modules/trust-module.tsx', 'utf8');
  const css = readFileSync('app/globals.css', 'utf8');
  /** The light theme's colour for a raw palette text class, with any alpha it carries (A11Y-001, #991). */
  const lightText = (cls: string): [number[], number] => {
    const esc = cls.replace('/', '\\/');
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.includes(`.${esc}:`) || sel.includes(`.${esc} `)) {
        if (!sel.includes(':where(.light)') || /hover|group/.test(sel)) continue;
        const m = /rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?/.exec(body)!;
        return [[Number(m[1]), Number(m[2]), Number(m[3])], m[4] ? Number(m[4]) : 1];
      }
    }
    throw new Error(`no light colour for ${cls}`);
  };

  it('defaults are full colour, and the cell does not brighten on hover', () => {
    expect(trust).toContain("state === 'default-allow' && 'border-border bg-surface text-green-400',");
    expect(trust).toContain("state === 'default-approval' && 'border-border bg-surface text-amber-400',");
    expect(trust).toContain("state === 'default-deny' && 'border-border bg-surface text-muted',");
    expect(trust).toContain("canManage && 'hover:shadow-md cursor-pointer')}>");
    expect(trust).not.toContain('hover:brightness-125');
  });

  it('light: the old faint defaults fail, full colour passes, on the cell’s bg-surface', () => {
    const t = tokensOf('.light {');
    const on = (cls: string) => { const [ink, a] = lightText(cls); return contrast(over(ink, a, t.surface), t.surface); };
    // ✓ and ✕ are icons (3:1); "~" is text (4.5:1).
    expect(on('text-green-400/50')).toBeLessThan(3);
    expect(contrast(over(t.muted, 0.4, t.surface), t.surface)).toBeLessThan(3);
    expect(on('text-amber-400/60')).toBeLessThan(4.5);
    expect(on('text-green-400')).toBeGreaterThanOrEqual(4.5);
    expect(on('text-amber-400')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.muted, t.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('the allowed write-back fade is applied only to a button that is then disabled', () => {
    const wb = readFileSync('components/concierge/plan-write-backs.tsx', 'utf8');
    expect(wb).toContain('const disabled = !o.available || done || busy === o.kind || loadFailed;');
    expect(wb).toMatch(/: o\.available \? '[^']+'\s*: 'cursor-not-allowed text-muted\/50'/);
  });
});
