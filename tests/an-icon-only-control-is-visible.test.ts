import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { carriesText, worstOnGround } from './helpers/faded-text';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 1.4.11: a control whose only visible form is its icon needs
// 3:1 against the page. 24 icon-only buttons (delete, star, "more", rename,
// autopay, mark paid) painted their icon --muted at 40–60%: 1.76–2.44:1 in
// the light theme. They are full --muted now (5:1 or better). Hover still
// lifts them to their action colour.
//
// The bills autopay toggle showed whether it is on only by colour; it says
// so now (aria-pressed).

const CONTROL = /^(button|a|Link|ButtonLink|summary)$/;
const MUTED_AT = /^text-muted\/(\d{1,2})$/;

type Faint = { at: string; file: string; line: string; alpha: number };

/** Each control with no text of its own whose icon (or itself) is painted `text-muted/NN`. */
function faintIconControls(files: string[]): Faint[] {
  return files.flatMap((file) => scanSource(file, readFileSync(file, 'utf8')));
}

function scanSource(file: string, src: string): Faint[] {
  const found: Faint[] = [];
  if (!/text-muted\/\d/.test(src)) return found;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const classesOf = (n: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    const attr = n.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText(sf) === 'className');
    const parts: string[] = [];
    const collect = (x: ts.Node) => {
      if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) parts.push(x.text);
      else if (ts.isTemplateExpression(x)) parts.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
      ts.forEachChild(x, collect);
    };
    if (attr?.initializer) collect(attr.initializer);
    return parts.join(' ').split(/\s+/);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && CONTROL.test(node.openingElement.tagName.getText(sf)) && !carriesText(node)) {
      const within = (n: ts.Node) => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          for (const c of classesOf(n)) {
            const m = MUTED_AT.exec(c);
            if (m) found.push({ at: `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`, file, line: node.openingElement.getText(sf).replace(/\s+/g, ' '), alpha: Number(m[1]) / 100 });
          }
        }
        ts.forEachChild(n, within);
      };
      within(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// None: the sidebar's pin button, the last one allowed, is full --muted now.
const ALLOWED: { file: string; has: string; why: string }[] = [];

describe('an icon-only control is visible at 3:1', () => {
  const found = faintIconControls([...sourceFiles('components'), ...sourceFiles('app')]);

  it('finds a faint icon-only control (non-vacuity), and none below 3:1 in the source but the allowed', () => {
    // The source has none left, so the scanner proves itself on the shape it was built for.
    expect(scanSource('p.tsx', `export const P = () => (<button aria-label="Pin" className="text-muted/50"><Star className="h-4 w-4" /></button>);`)).toHaveLength(1);
    const faint = found.filter((f) => worstOnGround('muted', f.alpha) < 3);
    const allowed = (f: Faint) => ALLOWED.some((a) => f.file === a.file && f.line.includes(a.has));
    expect(faint.filter((f) => !allowed(f)).map((f) => `${f.at} text-muted/${Math.round(f.alpha * 100)} ${worstOnGround('muted', f.alpha).toFixed(2)}: ${f.line.slice(0, 160)}`)).toEqual([]);
    for (const a of ALLOWED) expect(faint.some((f) => f.file === a.file && f.line.includes(a.has)), a.file).toBe(true);
  });

  it('the scanner counts a control with only an icon, and not one with words', () => {
    const probe = (jsx: string) => {
      const sf = ts.createSourceFile('p.tsx', `export const P = () => (${jsx});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let el: ts.JsxElement | undefined;
      const find = (n: ts.Node) => { if (!el && ts.isJsxElement(n)) el = n; else ts.forEachChild(n, find); };
      find(sf);
      return carriesText(el!);
    };
    expect(probe(`<button aria-label="Delete" className="text-muted/40"><Trash2 className="h-4 w-4" /></button>`)).toBe(false);
    expect(probe(`<button className="text-muted/40">{paid ? <RotateCcw /> : <Check />}</button>`)).toBe(false);
    expect(probe(`<button className="text-muted/40"><Trash2 /> {label}</button>`)).toBe(true);
  });

  it('the arithmetic: --muted at 40–60% is under 3:1 on some ground; full --muted clears it', () => {
    for (const a of [0.4, 0.5, 0.6]) expect(worstOnGround('muted', a), `muted at ${a}`).toBeLessThan(3);
    expect(worstOnGround('muted', 1)).toBeGreaterThanOrEqual(4.5);
  });

  it('the autopay toggle says whether it is on', () => {
    expect(readFileSync('components/finance/bills-view.tsx', 'utf8')).toContain("onClick={() => toggleAutopay(b)} title={t('bills.toggleAutoPay')} aria-pressed={!!b.autopay}");
  });
});
