import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Text whose colour is a theme token at reduced alpha (`text-muted/50`,
// `text-brand-text/70`), read from the source with the TypeScript parser.
// Shared by tests/token-text-at-reduced-alpha-is-readable.test.ts.

export type AlphaText = { at: string; file: string; line: string; tag: string; token: string; alpha: number };

/** The text-colour class an element is painted with: a bare `text-<token>/NN` (no hover:, placeholder: … variant). */
const ALPHA_TEXT = /^text-(muted|fg|brand-text|brand|danger|success|warning|accent)\/(\d{1,2})$/;

/** Every element painted `text-<token>/NN` whose subtree renders words or numbers. */
export function alphaText(files: string[]): AlphaText[] {
  const found: AlphaText[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!/text-(muted|fg|brand-text|brand|danger|success|warning|accent)\/\d/.test(src)) continue;
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
          const disabled = attr('disabled');
          const exempt = attr('aria-hidden') || (disabled && disabled.initializer?.getText(sf) !== '{false}');
          if (!exempt && carriesText(node)) {
            for (const c of parts.join(' ').split(/\s+/)) {
              const m = ALPHA_TEXT.exec(c);
              if (!m) continue;
              const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
              found.push({
                at: `${file}:${line + 1}`, file, tag: open.tagName.getText(sf), token: m[1], alpha: Number(m[2]) / 100,
                line: `${lines[line]} ${open.getText(sf)}`.replace(/\s+/g, ' ').trim(),
              });
            }
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
export function carriesText(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
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

// WCAG contrast, with tints composited in 8-bit steps as the browser paints them.
const css = readFileSync('app/globals.css', 'utf8');
export function tokensOf(selector: string): Record<string, number[]> {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(0, block.indexOf('}'));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(\d+) (\d+) (\d+);/g)].map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])]]));
}
const lum = (c: number[]) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
export const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const over = (top: number[], alpha: number, under: number[]) => top.map((v, i) => Math.round(v * alpha + under[i] * (1 - alpha)));
export const THEMES = [['light', '.light {'], ['dark', '.dark {']] as const;
export const GROUNDS = ['bg', 'surface', 'elevated'] as const;

/** The worst contrast of `token` at `alpha` over a plain page ground, in either theme. */
export function worstOnGround(token: string, alpha: number): number {
  let worst = Infinity;
  for (const [, selector] of THEMES) {
    const t = tokensOf(selector);
    const ink = t[token === 'brand' ? 'brand' : token];
    for (const g of GROUNDS) worst = Math.min(worst, contrast(over(ink, alpha, t[g]), t[g]));
  }
  return worst;
}
