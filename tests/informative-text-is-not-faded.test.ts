import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { carriesText, contrast, fadedText, GROUNDS, over, scanFiles, scanSource, THEMES, tokensOf } from './helpers/faded-text';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001: text was faded with an `opacity-*` utility to look secondary, done,
// resolved or skipped. Opacity multiplies the text's own contrast, so a
// faded label reads far below 4.5:1 (the arithmetic is below): the second
// half of a chip ("· Spanish", "(admin)", "(now)"), a checked note item,
// a completed reminder, a resolved symptom, a message's time, a calendar
// chip's who-and-where. Being done is not being inactive: WCAG exempts only
// inactive controls, and the text is still the record.
//
// Each was drawn at full strength, its state carried by what the row
// already says ("Resolved", "Suspended", "Noted", "Claimed by", a strike-
// through, a switch, the section it is in) or by a dashed border where the
// fade was the only cue. A done fridge-chef button is disabled now instead
// of faded and unclickable only by mouse: Enter still pressed it, and on
// "Added to grocery" it would add the items again (addToGrocery has no
// guard for an item already added).
//
// The scanner, and what it does and does not read, is tests/helpers/faded-text.ts.

// What is still faded on purpose, and why.
const ALLOWED: { file: string; has: string; why: string }[] = [
  { file: 'components/modules/scan-module.tsx', has: "scanning && 'pointer-events-none opacity-70'", why: 'the form while a scan runs: inactive, and announced as busy' },
];

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('informative text is not faded with opacity', () => {
  it('finds faded text in the source (non-vacuity), and only the allowed sites', () => {
    const found = fadedText(scanFiles(files, /opacity-[1-9]/));
    const allowed = (f: (typeof found)[number]) => ALLOWED.some((a) => f.file === a.file && f.line.includes(a.has));
    expect(found.filter((f) => !allowed(f)).map((f) => `${f.at} <${f.tag}> ${f.fade}: ${f.line}`)).toEqual([]);
    // Each allowance still names a real site.
    for (const a of ALLOWED) {
      expect(found.some((f) => f.file === a.file && f.line.includes(a.has)), a.file).toBe(true);
    }
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('what counts as text: through cn(), conditions, && and .map; not an icon', () => {
    const probe = (jsx: string) => {
      const src = `export function P() { return (${jsx}); }`;
      const sf = ts.createSourceFile('p.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let el: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
      const find = (n: ts.Node) => { if (!el && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) el = n; else ts.forEachChild(n, find); };
      find(sf);
      return carriesText(el!);
    };
    expect(probe(`<span className="opacity-70">· {g.language_label}</span>`)).toBe(true);
    expect(probe(`<div className={cn('x', done && 'opacity-50')}>{done ? <Check /> : <X />}<p>{title}</p></div>`)).toBe(true);
    expect(probe(`<ul className="opacity-60">{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>`)).toBe(true);
    expect(probe(`<div className="opacity-60"><Icon className="h-4 w-4" /></div>`)).toBe(false);
    expect(probe(`<div className="opacity-60">{open && <Icon />}</div>`)).toBe(false);
    expect(probe(`<Icon className="opacity-60" />`)).toBe(false);
  });

  // Through the real scanner: is this faded label found?
  const flagged = (body: string, prelude = '') =>
    fadedText(scanSource('fixture.tsx', `${prelude}\nexport function P({ pending, hidden, k }: any) { return (${body}); }`)).length === 1;

  it('exempts only an element that is certainly inactive or hidden: disabled and aria-hidden written true', () => {
    // Certainly inactive or hidden: not scanned.
    expect(flagged(`<button disabled className="opacity-60">Save</button>`)).toBe(false);
    expect(flagged(`<button disabled={true} className="opacity-60">Save</button>`)).toBe(false);
    expect(flagged(`<span aria-hidden className="opacity-60">Save</span>`)).toBe(false);
    expect(flagged(`<span aria-hidden="true" className="opacity-60">Save</span>`)).toBe(false);
    expect(flagged(`<span aria-hidden={true} className="opacity-60">Save</span>`)).toBe(false);
    // Can render enabled and visible: scanned.
    expect(flagged(`<button disabled={false} className="opacity-60">Save</button>`)).toBe(true);
    expect(flagged(`<button disabled={pending} className={cn(pending && 'opacity-60')}>Save</button>`)).toBe(true);
    expect(flagged(`<span aria-hidden={false} className="opacity-60">Save</span>`)).toBe(true);
    expect(flagged(`<span aria-hidden="false" className="opacity-60">Save</span>`)).toBe(true);
    expect(flagged(`<span aria-hidden={hidden} className="opacity-60">Save</span>`)).toBe(true);
    // A look is not a state.
    expect(flagged(`<label className="cursor-not-allowed opacity-60">Upload</label>`)).toBe(true);
    // Variants are states or reveals, not fades of the resting text.
    expect(flagged(`<button className="disabled:opacity-50 hover:opacity-80">Save</button>`)).toBe(false);
  });

  it('follows a class held in a same-file const, or a const map of them; not an import or a function', () => {
    expect(flagged(`<p className={DONE}>Milk</p>`, `const DONE = 'line-through opacity-50';`)).toBe(true);
    expect(flagged(`<p className={cn('text-sm', TONE[k])}>Milk</p>`, `const TONE = { done: 'opacity-50', open: '' } as const;`)).toBe(true);
    expect(flagged(`<p className={TONE.done}>Milk</p>`, `const TONE = { done: { row: 'opacity-50' } };`)).toBe(true);
    // Outside the guard, and stated as such in the helper:
    expect(flagged(`<p className={DONE}>Milk</p>`, `import { DONE } from './tones';`)).toBe(false);
    expect(flagged(`<p className={tone(k)}>Milk</p>`, `const tone = (k: string) => (k === 'done' ? 'opacity-50' : '');`)).toBe(false);
    let reassigned = 'opacity-50'; reassigned += '';
    expect(flagged(`<p className={DONE}>Milk</p>`, `let DONE = '${reassigned}';`)).toBe(false);
  });
});

// The arithmetic behind the fixes: WCAG contrast, tints composited in 8-bit
// steps as the browser paints them, over the darkest and lightest grounds.
const worst = (f: (ground: number[]) => number, t: Record<string, number[]>) => Math.min(...GROUNDS.map((g) => f(t[g])));

describe('the faded text failed, and its full-strength replacement passes', () => {
  for (const [theme, selector] of THEMES) {
    const t = tokensOf(selector);
    it(`${theme}: an inactive chip's second half, a done row's muted text, a message's time`, () => {
      const chip = (g: number[]) => over(t.surface, 0.4, g);
      // Before: muted at 70% in an inactive chip, brand-text at 70% in an active one, muted at 50–60% in a done row.
      expect(worst((g) => contrast(over(t.muted, 0.7, chip(g)), chip(g)), t)).toBeLessThan(4.5);
      expect(worst((g) => { const bg = over(t.brand, 0.15, g); return contrast(over(t['brand-text'], 0.7, bg), bg); }, t)).toBeLessThan(4.5);
      expect(worst((g) => contrast(over(t.muted, 0.5, g), g), t)).toBeLessThan(4.5);
      expect(contrast(over(t.muted, 0.6, t.elevated), t.elevated)).toBeLessThan(4.5);
      expect(contrast(over(t['brand-fg'], 0.6, t.brand), t.brand)).toBeLessThan(4.5);
      // After: the same text at full strength.
      expect(worst((g) => contrast(t.muted, chip(g)), t)).toBeGreaterThanOrEqual(4.5);
      expect(worst((g) => { const bg = over(t.brand, 0.15, g); return contrast(t['brand-text'], bg); }, t)).toBeGreaterThanOrEqual(4.5);
      expect(worst((g) => contrast(t.muted, g), t)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted, t.elevated)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['brand-fg'], t.brand)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('an attachment in your own message is outlined, not tinted: the tint took its name below 4.5', () => {
    const messages = readFileSync('components/modules/messages-module.tsx', 'utf8');
    expect(messages).toContain("isMine ? 'border-brand-fg/40' : 'border-border bg-surface/50',");
    for (const [theme, selector] of THEMES) {
      const t = tokensOf(selector);
      expect(contrast(t['brand-fg'], over(t['brand-fg'], 0.1, t.brand)), `${theme} control`).toBeLessThan(4.5);
      expect(contrast(t['brand-fg'], t.brand), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a red alert’s detail line is full danger, not 80% of it', () => {
    for (const [theme, selector] of THEMES) {
      const t = tokensOf(selector);
      expect(worst((g) => { const bg = over(t.danger, 0.05, g); return contrast(over(t.danger, 0.8, bg), bg); }, t), `${theme} control`).toBeLessThan(4.5);
      expect(worst((g) => { const bg = over(t.danger, 0.05, g); return contrast(t.danger, bg); }, t), theme).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('a done or selected control says so', () => {
  it('a fridge-chef button that has done its job is disabled, not faded and unclickable only by mouse', () => {
    const chef = readFileSync('components/meals/fridge-chef.tsx', 'utf8');
    expect(chef).not.toContain('pointer-events-none');
    expect(chef).toContain('disabled={planningIndex !== null || planned.has(i)}');
    expect(chef).toContain('disabled={addingIndex !== null || added.has(i)}');
  });

  it('a scanned event says whether it is selected', () => {
    const scan = readFileSync('components/modules/scan-module.tsx', 'utf8');
    expect(scan).toMatch(/onClick=\{\(\) => toggle\(i\)\}\s+aria-pressed=\{selected\.has\(i\)\}/);
  });
});

// The calendar chips' who-and-where now inherit the chip's own colour, so the
// chip's hover is theirs too. It was hover:brightness-110. A filter brightens
// the element's own layer (its ink, and its 20% tint) but not the page behind
// the tint, so in the light theme the ink lifts toward the background: rendered
// in Chromium, medication went from 4.75 to 4.14, general 4.95 to 4.38, school
// 5.08 to 4.49. The hover is a shadow now, which leaves both colours alone.
describe('a calendar chip keeps its contrast when hovered', () => {
  const cal = readFileSync('components/modules/calendar-module.tsx', 'utf8');
  const css = readFileSync('app/globals.css', 'utf8');
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  /** The light theme's replacement for a raw palette text colour (A11Y-001, #991). */
  const lightText = (fam: string, shade: string) => {
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sel.includes(`.text-${fam}-${shade}:`) && sel.includes(':where(.light)') && !/hover|group/.test(sel)) {
        const m = /rgb\((\d+) (\d+) (\d+)/.exec(body)!;
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      }
    }
    throw new Error(`no light colour for text-${fam}-${shade}`);
  };
  const block = cal.slice(cal.indexOf('const CATEGORY_COLORS'), cal.indexOf('};', cal.indexOf('const CATEGORY_COLORS')));
  const categories = [...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]] as const);
  const bright = (c: number[], k: number) => c.map((v) => Math.min(255, Math.round(v * k)));

  /** The chip's ink, and its tint (colour and alpha), in a theme. */
  async function paint(classes: string, theme: 'light' | 'dark', t: Record<string, number[]>) {
    const colors = (await import('tailwindcss/colors')).default as unknown as Record<string, Record<string, string>>;
    const bg = /(?:^| )bg-([a-z]+)(?:-(\d+))?(?:\/(\d+))?(?= |$)/.exec(classes)!;
    const fg = /(?:^| )text-([a-z-]+?)(?:-(\d+))?(?= |$)/.exec(classes)!;
    const tint = bg[2] ? hex(colors[bg[1]][bg[2]]) : t[bg[1]];
    const ink = fg[2] ? (theme === 'light' ? lightText(fg[1], fg[2]) : hex(colors[fg[1]][fg[2]])) : t[fg[1]];
    return { ink, tint, alpha: bg[3] ? Number(bg[3]) / 100 : 1 };
  }

  it('no chip brightens on hover; the three chips lift with a shadow', () => {
    expect(categories).toHaveLength(9); // non-vacuity: every category, "other" included
    expect(cal).not.toMatch(/hover:brightness-/);
    expect(cal.match(/cursor-pointer[^']*hover:shadow-md/g)).toHaveLength(3);
  });

  for (const [theme, selector] of THEMES) {
    it(`${theme}: every category clears 4.5:1 idle (and so hovered), over every ground`, async () => {
      const t = tokensOf(selector);
      for (const [name, classes] of categories) {
        const { ink, tint, alpha } = await paint(classes, theme, t);
        for (const g of GROUNDS) expect(contrast(ink, over(tint, alpha, t[g])), `${name} over --${g}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('control: the old brightness(1.1), applied to the chip’s own layer, takes three light categories under 4.5 on the page', async () => {
    const t = tokensOf('.light {');
    const under: string[] = [];
    for (const [name, classes] of categories) {
      const { ink, tint, alpha } = await paint(classes, 'light', t);
      if (contrast(bright(ink, 1.1), over(bright(tint, 1.1), alpha, t.bg)) < 4.5) under.push(name);
    }
    expect(under.sort()).toEqual(['general', 'medication', 'school']);
  });
});
