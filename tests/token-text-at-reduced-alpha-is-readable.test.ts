import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';
import { alphaText, contrast, GROUNDS, over, THEMES, tokensOf, worstOnGround } from './helpers/faded-text';

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

const ALLOWED: { file: string; has: string; why: string }[] = [
  { file: 'components/app/app-shell.tsx', has: 'text-muted/70', why: 'the sidebar’s group headings: the sidebar is not changed here' },
  { file: 'components/app/free-tier-sidebar.tsx', has: 'text-muted/80', why: 'the free-tier sidebar’s group headings: not changed here' },
  { file: 'components/app/free-tier-sidebar.tsx', has: 'text-muted/50', why: 'the free-tier sidebar’s counts and locked items: not changed here' },
  { file: 'components/app/nav-shared.tsx', has: 'text-muted/45', why: 'a locked (upgrade) nav item: not changed here' },
];

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('token text at reduced alpha reads at 4.5:1', () => {
  it('finds it in the source (non-vacuity), and nothing below 4.5:1 on a plain ground but the allowed sites', () => {
    const found = alphaText(files);
    expect(found.length).toBeGreaterThan(50);
    expect(found.some((f) => f.token === 'fg' && f.alpha === 0.8)).toBe(true);
    const below = found.filter((f) => worstOnGround(f.token, f.alpha) < 4.5);
    const allowed = (f: (typeof found)[number]) => ALLOWED.some((a) => f.file === a.file && f.line.includes(a.has));
    expect(below.filter((f) => !allowed(f)).map((f) => `${f.at} text-${f.token}/${Math.round(f.alpha * 100)} ${worstOnGround(f.token, f.alpha).toFixed(2)}: ${f.line.slice(0, 160)}`)).toEqual([]);
    for (const a of ALLOWED) expect(below.some((f) => f.file === a.file && f.line.includes(a.has)), `${a.file} ${a.has}`).toBe(true);
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
