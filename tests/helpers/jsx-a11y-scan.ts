import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import ts from 'typescript';

// A small JSX walker for the two accessibility properties the lint rule cannot
// see (A11Y-002 relied on jsx-a11y/label-has-associated-control, which treats
// any `{expression}` child, i.e. every `{t('…')}` label, as a possible nested
// control and so never reports it). Parsed, not grepped: a button split over
// five lines is still one button.

export type Site = { file: string; line: number; what: string };

export function sourceFiles(): string[] {
  return execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' })
    .trim().split('\n').filter((f) => f && !f.includes('.test.'));
}

function parse(file: string, text = readFileSync(file, 'utf8')) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const attrNames = (attrs: ts.JsxAttributes) =>
  attrs.properties.map((p) => (ts.isJsxSpreadAttribute(p) ? '...' : p.name.getText()));

const meaningfulChildren = (children: ts.NodeArray<ts.JsxChild>) =>
  children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces) && !(ts.isJsxExpression(c) && !c.expression));

const isIcon = (n: ts.Node): n is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(n) && /^[A-Z]/.test(n.tagName.getText());
const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);

/** The icon a child renders if that is ALL it renders: `<Icon />`, `{on ? <A /> : <B />}`, `{on && <A />}`. */
function iconOnly(child: ts.JsxChild): string | null {
  if (isIcon(child)) return `<${child.tagName.getText()} />`;
  if (ts.isJsxExpression(child) && child.expression) {
    const e = unwrap(child.expression);
    if (ts.isConditionalExpression(e)) {
      const a = unwrap(e.whenTrue); const b = unwrap(e.whenFalse);
      if (isIcon(a) && isIcon(b)) return `<${a.tagName.getText()} /> | <${b.tagName.getText()} />`;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isIcon(unwrap(e.right))) {
      return `<${(unwrap(e.right) as ts.JsxSelfClosingElement).tagName.getText()} />`;
    }
  }
  return null;
}

/** A button is labelable: a `<label>` around it names it (HTML-AAM), as in a custom checkbox. */
function insideLabel(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === 'label') return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** `<button …><Icon /></button>`: a native button whose only content is an icon. */
export function unnamedIconButtons(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'button') {
      const names = attrNames(node.openingElement.attributes);
      const named = names.some((n) => n === 'aria-label' || n === 'aria-labelledby' || n === 'title' || n === '...') || insideLabel(node);
      const kids = meaningfulChildren(node.children);
      const icon = kids.length === 1 ? iconOnly(kids[0]) : null;
      if (!named && icon) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: icon });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const CONTROL = /^(input|select|textarea|button|meter|progress|output)$|^[A-Z]/;

/** `<label>` with no htmlFor that wraps nothing a user can operate. */
export function detachedLabels(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const containsControl = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && CONTROL.test(n.tagName.getText())) found = true;
      // `{children}` and other passed-in content: the control arrives from the caller.
      else if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression) && n.expression.text === 'children') found = true;
      else ts.forEachChild(n, walk);
    };
    ts.forEachChild(node, walk);
    return found;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'label') {
      const names = attrNames(node.openingElement.attributes);
      if (!names.includes('htmlFor') && !names.includes('...') && !containsControl(node)) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: node.children.map((c) => c.getText()).join('').replace(/\s+/g, ' ').trim().slice(0, 60) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
