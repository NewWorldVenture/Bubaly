import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The JSX scanner behind the faded-text guards (A11Y-001), read with the
// TypeScript parser:
//   - tests/informative-text-is-not-faded.test.ts (`opacity-N` on text),
//   - tests/token-text-at-reduced-alpha-is-readable.test.ts (`text-<token>/NN`),
//   - tests/an-icon-only-control-is-visible.test.ts (faint icon-only controls).
//
// What it reads, and what it does not:
//   - the string literals anywhere in a `className` expression: plain strings,
//     template text, `cn(…)` arguments, both arms of `?:` and `&&`;
//   - a name in it that the same file binds with `const` to a string, or to
//     an object of strings (`CATEGORY_COLORS[e.category]` counts every value);
//   - NOT a class built at run time, imported from another file, or returned
//     by a function: those are outside this guard.
// An element is exempt only when it is certainly hidden from assistive tech
// or certainly inactive: `aria-hidden` or `disabled` written bare, as "true",
// or as {true}. A dynamic value (`disabled={pending}`) or false is scanned,
// since the element can render enabled and visible; so is cursor-not-allowed,
// which is only a look.

export type Site = { at: string; file: string; line: string; tag: string; classes: string[]; text: boolean; exempt: boolean };

/** Every JSX element with a className in one source file. */
export function scanSource(file: string, src: string): Site[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = src.split('\n');
  const aliases = constStrings(sf);
  const found: Site[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const className = attribute(open, 'className', sf);
      if (className?.initializer) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
        found.push({
          at: `${file}:${line + 1}`,
          file,
          line: `${lines[line]} ${open.getText(sf)}`.replace(/\s+/g, ' ').trim(),
          tag: open.tagName.getText(sf),
          classes: classStrings(className.initializer, aliases).join(' ').split(/\s+/).filter(Boolean),
          text: carriesText(node),
          exempt: literallyTrue(attribute(open, 'aria-hidden', sf)) || literallyTrue(attribute(open, 'disabled', sf)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function scanFiles(files: string[], mention: RegExp): Site[] {
  return files.flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    return mention.test(src) ? scanSource(file, src) : [];
  });
}

function attribute(open: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string, sf: ts.SourceFile) {
  return open.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText(sf) === name);
}

/** `disabled`, `disabled="true"`, `disabled={true}`: yes. `{false}`, `{pending}`, absent: no. */
function literallyTrue(attr: ts.JsxAttribute | undefined): boolean {
  if (!attr) return false;
  const init = attr.initializer;
  if (!init) return true;
  if (ts.isStringLiteral(init)) return init.text === 'true';
  return ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.TrueKeyword;
}

/** The same file's `const NAME = 'classes'` and `const NAME = { key: 'classes', … }`. */
function constStrings(sf: ts.SourceFile): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const strings = (x: ts.Expression): string[] | null => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return [x.text];
    if (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x)) return strings(x.expression);
    if (ts.isObjectLiteralExpression(x)) {
      const out: string[] = [];
      for (const p of x.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) out.push(p.initializer.text);
        else if (ts.isObjectLiteralExpression(p.initializer)) out.push(...(strings(p.initializer) ?? []));
      }
      return out.length ? out : null;
    }
    return null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      const s = strings(n.initializer);
      if (s) map.set(n.name.text, s);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

/** Every class string a className expression can produce, following same-file const aliases. */
function classStrings(expr: ts.Node, aliases: Map<string, string[]>): string[] {
  const out: string[] = [];
  const collect = (x: ts.Node) => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) { out.push(x.text); return; }
    if (ts.isTemplateExpression(x)) out.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
    if (ts.isIdentifier(x) && aliases.has(x.text)) out.push(...aliases.get(x.text)!);
    ts.forEachChild(x, collect);
  };
  collect(expr);
  return out;
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

/** A bare fade: `opacity-N`, 0 < N < 100, with no variant (hover:, disabled:, sm: … are states or reveals). */
export const FADE = /^opacity-([1-9]\d?)$/;
/** A theme colour at reduced alpha as the text colour, with no variant. */
export const ALPHA_TEXT = /^text-(muted|fg|brand-text|brand|danger|success|warning|accent)\/(\d{1,2})$/;

export type AlphaText = Site & { token: string; alpha: number };

/** Every text-bearing, non-exempt element painted `text-<token>/NN`. */
export function alphaText(sites: Site[]): AlphaText[] {
  return sites.filter((s) => s.text && !s.exempt).flatMap((s) => s.classes.flatMap((c) => {
    const m = ALPHA_TEXT.exec(c);
    return m ? [{ ...s, token: m[1], alpha: Number(m[2]) / 100 }] : [];
  }));
}

/** Every text-bearing, non-exempt element with a bare `opacity-N`. */
export function fadedText(sites: Site[]): (Site & { fade: string })[] {
  return sites.filter((s) => s.text && !s.exempt).flatMap((s) => {
    const fade = s.classes.find((c) => FADE.test(c));
    return fade ? [{ ...s, fade }] : [];
  });
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
    for (const g of GROUNDS) worst = Math.min(worst, contrast(over(t[token], alpha, t[g]), t[g]));
  }
  return worst;
}
