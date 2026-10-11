import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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

/** `line`: the source line the element opens on, then its whole opening tag. */
type Fade = { at: string; file: string; line: string; tag: string; fade: string };

/** Every element with a bare `opacity-N` (0 < N < 100) whose subtree carries text. */
function fadedText(files: string[]): Fade[] {
  const found: Fade[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!/opacity-[1-9]/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lines = src.split('\n');
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const open = ts.isJsxElement(node) ? node.openingElement : node;
        const attrs = open.attributes.properties.filter(ts.isJsxAttribute);
        const attr = (name: string) => attrs.find((a) => a.name.getText(sf) === name);
        const className = attr('className');
        if (className?.initializer) {
          const parts: string[] = [];
          const collect = (x: ts.Node) => {
            if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) parts.push(x.text);
            else if (ts.isTemplateExpression(x)) parts.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
            ts.forEachChild(x, collect);
          };
          collect(className.initializer);
          const classes = parts.join(' ').split(/\s+/);
          // A bare fade: no variant (hover:, disabled:, sm:, group-hover: … are states or reveals).
          const fade = classes.find((c) => /^opacity-([1-9]\d?)$/.test(c));
          const disabled = attr('disabled');
          const exempt = attr('aria-hidden') || (disabled && disabled.initializer?.getText(sf) !== '{false}') || classes.includes('cursor-not-allowed');
          if (fade && !exempt && carriesText(node)) {
            const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
            found.push({ at: `${file}:${line + 1}`, file, line: `${lines[line]} ${open.getText(sf)}`.replace(/\s+/g, ' ').trim(), tag: open.tagName.getText(sf), fade });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** Whether an element renders words or numbers: JSX text, or an expression that is not markup. */
function carriesText(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (ts.isJsxSelfClosingElement(node)) return false;
  const content = (x: ts.Expression | undefined): boolean => {
    if (!x) return false;
    if (ts.isParenthesizedExpression(x)) return content(x.expression);
    if (ts.isJsxElement(x) || ts.isJsxFragment(x)) return x.children.some(child);
    if (ts.isJsxSelfClosingElement(x)) return false;
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return content(x.right);
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.BarBarToken || x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return content(x.left) || content(x.right);
    if (ts.isConditionalExpression(x)) return content(x.whenTrue) || content(x.whenFalse);
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'map') {
      const fn = x.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        if (!ts.isBlock(fn.body)) return content(fn.body);
        let any = false;
        const ret = (n: ts.Node) => { if (ts.isReturnStatement(n)) any ||= content(n.expression); else if (!ts.isFunctionLike(n)) ts.forEachChild(n, ret); };
        ts.forEachChild(fn.body, ret);
        return any;
      }
    }
    if (x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(x) && x.text === 'undefined') return false;
    return true; // a string, a name, a count, tr(…), fmtDate(…)
  };
  const child = (c: ts.JsxChild): boolean => {
    if (ts.isJsxText(c)) return /[\p{L}\p{N}]/u.test(c.text);
    if (ts.isJsxExpression(c)) return content(c.expression);
    return content(c as ts.Expression);
  };
  return node.children.some(child);
}

// What is still faded on purpose, and why.
const ALLOWED: { file: string; has: string; why: string }[] = [
  { file: 'components/modules/scan-module.tsx', has: "scanning && 'pointer-events-none opacity-70'", why: 'the form while a scan runs: inactive, and announced as busy' },
];

const files = [...sourceFiles('components'), ...sourceFiles('app')];

describe('informative text is not faded with opacity', () => {
  it('finds faded text in the source (non-vacuity), and only the allowed sites', () => {
    const found = fadedText(files);
    const allowed = (f: Fade) => ALLOWED.some((a) => f.file === a.file && f.line.includes(a.has));
    expect(found.filter((f) => !allowed(f)).map((f) => `${f.at} <${f.tag}> ${f.fade}: ${f.line}`)).toEqual([]);
    // Each allowance still names a real site.
    for (const a of ALLOWED) {
      expect(found.some((f) => f.file === a.file && f.line.includes(a.has)), a.file).toBe(true);
    }
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it('the scanner sees through cn(), conditions, && and .map, and skips icons, aria-hidden and disabled', () => {
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
});

// The arithmetic behind the fixes: WCAG contrast, tints composited in 8-bit
// steps as the browser paints them, over the darkest and lightest grounds.
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
