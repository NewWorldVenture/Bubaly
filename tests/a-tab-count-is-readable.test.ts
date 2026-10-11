import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A11Y-001, from an axe sweep of a seeded household in the light theme: two
// tab counts sat on a tint stacked on another one.
//   - Todos: the active tab is bg-brand/15 and its count was bg-brand/25 on
//     top, brand-text on ~36% brand: 3.89:1. The count is solid brand with
//     brand-fg now.
//   - Photos: the favourites count was bg-fg/10 inside the tab. Inactive, its
//     --muted text read 4.20:1 on the light page; with the Favourites tab
//     active (bg-brand/20, brand-text), 4.05 light and 3.82 dark. It has no
//     tint of its own now, so it reads exactly as the tab's label does.

const css = readFileSync('app/globals.css', 'utf8');
function tokensOf(selector: string): Record<string, number[]> {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(0, block.indexOf('}'));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(\d+) (\d+) (\d+);/g)].map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])]]));
}
const lum = (c: number[]) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (top: number[], alpha: number, under: number[]) => top.map((v, i) => Math.round(v * alpha + under[i] * (1 - alpha)));
const THEMES = [['light', '.light {'], ['dark', '.dark {']] as const;
const GROUNDS = ['bg', 'surface', 'elevated'] as const;

/** `bg-brand/20 text-brand-text` → the tint's token and alpha, and the text token. */
function classes(list: string) {
  const bg = list.match(/(?:^|\s)bg-([\w-]+)\/(\d+)(?:\s|$)/);
  const text = list.match(/(?:^|\s)text-([\w-]+)(?:\s|$)/);
  return { tint: bg ? { token: bg[1], alpha: Number(bg[2]) / 100 } : null, text: text?.[1] };
}

describe('a tab’s count is readable', () => {
  it('todos: the active tab’s count is solid brand, not a brand tint on the brand-tinted tab', () => {
    const todos = readFileSync('components/modules/todos-module.tsx', 'utf8');
    expect(todos).toContain("tab === t.id ? 'bg-brand/15 text-brand-text'"); // the active tab (non-vacuity)
    expect(todos).toContain("tab === t.id ? 'bg-brand text-brand-fg' : 'bg-elevated text-muted')}>{t.n}</span>");
    expect(todos).not.toContain("'bg-brand/25 text-brand-text'");
    for (const [theme, selector] of THEMES) {
      const t = tokensOf(selector);
      expect(contrast(t['brand-fg'], t.brand), theme).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted, t.elevated), `${theme} inactive count`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('photos: the favourites count has no tint of its own, and the tab clears 4.5:1 active, inactive and hovered', () => {
    const photos = readFileSync('components/modules/photos-module.tsx', 'utf8');
    expect(photos).toContain("className={cn('tab-item', tab === key ? 'tab-item-active' : 'tab-item-inactive')}>");
    expect(photos).toContain("{key === 'favorites' && <span className=\"ml-1 text-[10px]\">");
    // The tab's states, from their definitions in globals.css.
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{\\s*@apply ([^;]+);`))?.[1] ?? '';
    const active = classes(rule('tab-item-active'));
    const inactive = classes(rule('tab-item-inactive').replace(/hover:\S+/g, ''));
    const hovered = classes(rule('tab-item-inactive').split(/\s+/).filter((c) => c.startsWith('hover:')).map((c) => c.slice(6)).join(' '));
    expect(active).toEqual({ tint: { token: 'brand', alpha: 0.2 }, text: 'brand-text' }); // non-vacuity
    expect(inactive).toEqual({ tint: null, text: 'muted' });
    expect(hovered.text).toBe('fg');
    for (const [theme, selector] of THEMES) {
      const t = tokensOf(selector);
      for (const ground of GROUNDS) {
        const under = t[ground];
        expect(under, `${theme} --${ground}`).toBeDefined();
        expect(contrast(t[active.text!], over(t[active.tint!.token], active.tint!.alpha, under)), `${theme} active over --${ground}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[inactive.text!], under), `${theme} inactive over --${ground}`).toBeGreaterThanOrEqual(4.5);
      }
      // `hover:bg-elevated` is solid, so the ground underneath no longer shows.
      expect(contrast(t[hovered.text!], t[hovered.tint?.token ?? 'elevated']), `${theme} hovered`).toBeGreaterThanOrEqual(4.5);
      // The control: the old bg-fg/10 count on the active tab, over its worst ground.
      const old = Math.min(...GROUNDS.map((g) => contrast(t['brand-text'], over(t.fg, 0.1, over(t.brand, 0.2, t[g])))));
      expect(old, `${theme} control`).toBeLessThan(4.5);
    }
  });
});
