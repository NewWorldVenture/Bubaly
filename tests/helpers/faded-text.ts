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
//   - a name in it, resolved by lexical scope to the `const` that binds it in
//     this file, when that const is a string, a `?:` of strings, or an object
//     of them (`CATEGORY_COLORS[e.category]` counts every value). A name a
//     nearer scope rebinds (a parameter, a `let`, a destructured or loop
//     variable, an import, a function) is that binding, not an outer const;
//   - NOT a class built at run time, imported from another file, returned by
//     a function, or bound by `let`: those are outside this guard.
// An element is exempt only when it is certainly inactive or certainly hidden:
//   - `disabled` written bare, as "true" or as {true}, on an element that can
//     be disabled (a native form control, or the design system's <Button>,
//     which passes it to one). On a <p> it disables nothing;
//   - `aria-hidden` written the same way: marked as decoration, the incidental
//     text WCAG 1.4.3 exempts (a placeholder emoji, a decorative layer).
// A dynamic value (`disabled={pending}`) or false is scanned, since the
// element can render enabled and visible; so is cursor-not-allowed, which is
// only a look.

/** Elements `disabled` actually disables: native form controls, and <Button>, which renders a <button>. */
const DISABLEABLE = /^(button|input|select|textarea|fieldset|optgroup|option|Button)$/;

export type Site = { at: string; file: string; line: string; tag: string; classes: string[]; text: boolean; ownText: boolean; exempt: boolean };

/** Every JSX element with a className in one source file. */
export function scanSource(file: string, src: string): Site[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = src.split('\n');
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
          classes: classStrings(className.initializer).join(' ').split(/\s+/).filter(Boolean),
          text: carriesText(node),
          ownText: carriesText(node, true),
          exempt: literallyTrue(attribute(open, 'aria-hidden', sf))
            || (DISABLEABLE.test(open.tagName.getText(sf)) && literallyTrue(attribute(open, 'disabled', sf))),
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

/** The strings a const initializer can hold: a string, a `?:` of strings, or an object of them. */
function literalStrings(x: ts.Expression): string[] | null {
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return [x.text];
  if (ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isParenthesizedExpression(x)) return literalStrings(x.expression);
  if (ts.isConditionalExpression(x)) {
    const a = literalStrings(x.whenTrue);
    const b = literalStrings(x.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isObjectLiteralExpression(x)) {
    const out: string[] = [];
    for (const p of x.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      out.push(...(literalStrings(p.initializer) ?? []));
    }
    return out.length ? out : null;
  }
  return null;
}

/** Whether a binding (a name, or a destructuring pattern) binds `name`. */
function binds(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name, name));
}

/**
 * The strings `id` holds, found by walking out through its scopes to the
 * nearest binding of its name. null when that binding is not a const of
 * literal strings: a parameter, a `let`, a destructured or loop variable, a
 * function, a class or an import.
 */
function resolve(id: ts.Identifier): string[] | null {
  const name = id.text;
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node) && node.parameters.some((p) => binds(p.name, name))) return null;
    if (ts.isCatchClause(node) && node.variableDeclaration && binds(node.variableDeclaration.name, name)) return null;
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node))
      && node.initializer && ts.isVariableDeclarationList(node.initializer)
      && node.initializer.declarations.some((d) => binds(d.name, name))) return null;
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const st of node.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (!binds(d.name, name)) continue;
            const constant = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
            return constant && ts.isIdentifier(d.name) && d.initializer ? literalStrings(d.initializer) : null;
          }
        }
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) return null;
        if (ts.isImportDeclaration(st) && st.importClause) {
          const c = st.importClause;
          if (c.name?.text === name) return null;
          const nb = c.namedBindings;
          if (nb && (ts.isNamespaceImport(nb) ? nb.name.text === name : nb.elements.some((e) => e.name.text === name))) return null;
        }
      }
    }
  }
  return null;
}

/** Every class string a className expression can produce, following const aliases by scope. */
function classStrings(expr: ts.Node): string[] {
  const out: string[] = [];
  const collect = (x: ts.Node) => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) { out.push(x.text); return; }
    if (ts.isTemplateExpression(x)) out.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
    if (ts.isPropertyAccessExpression(x)) { collect(x.expression); return; } // `TONE.done`: the object, not the key's name
    if (ts.isIdentifier(x)) { out.push(...(resolve(x) ?? [])); return; }
    ts.forEachChild(x, collect);
  };
  collect(expr);
  return out;
}

/** A class that paints an element's own background colour, so text inside it sits on that, not on its parent's fill. */
const OWN_FILL = /^bg-(?!transparent$|clip-|gradient-|none$|cover$|contain$|center$|no-repeat$|fixed$)/;

/**
 * Whether an element renders words or numbers: JSX text, or an expression that
 * is not markup. With `onOwnFill`, text inside a child element that paints its
 * own background (a tooltip, a badge) is that child's, not this element's, and
 * text inside a child marked aria-hidden is decoration.
 */
export function carriesText(node: ts.JsxElement | ts.JsxSelfClosingElement, onOwnFill = false): boolean {
  if (ts.isJsxSelfClosingElement(node)) return false;
  const paints = (el: ts.JsxElement) => {
    const className = attribute(el.openingElement, 'className', el.getSourceFile());
    return !!className?.initializer && classStrings(className.initializer).join(' ').split(/\s+/).some((c) => OWN_FILL.test(c));
  };
  const content = (x: ts.Expression | undefined): boolean => {
    if (!x) return false;
    if (ts.isParenthesizedExpression(x)) return content(x.expression);
    if (onOwnFill && ts.isJsxElement(x) && (paints(x) || literallyTrue(attribute(x.openingElement, 'aria-hidden', x.getSourceFile())))) return false;
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
