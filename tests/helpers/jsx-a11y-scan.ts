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

/**
 * Which `Field` a file uses. The ui kit's (`@/components/ui/input`) renders
 * `<label htmlFor={id}>` and hands that id to a render-prop child, so its
 * control is named only if it takes the id. The home and invest ones wrap the
 * child in a `<label>`, so anything inside is named.
 */
function fieldKindOf(sf: ts.SourceFile): 'render-prop' | 'wrapping' | null {
  let kind: 'render-prop' | 'wrapping' | null = null;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && /\bField\b/.test(st.importClause?.getText() ?? '')) {
      kind = (st.moduleSpecifier as ts.StringLiteral).text === '@/components/ui/input' ? 'render-prop' : 'wrapping';
    }
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'Field' && /<label\b/.test(st.getText())) kind = /htmlFor/.test(st.getText()) ? 'render-prop' : 'wrapping';
  }
  return kind;
}

function namedByField(node: ts.Node, idText: string | undefined, kind: 'render-prop' | 'wrapping' | null): boolean {
  if (!kind) return false;
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === 'Field') return kind === 'wrapping' || idText !== undefined;
  }
  return false;
}

/**
 * `<select>` (or the ui `Select`, which spreads its props onto one) with no
 * accessible name: no aria-label/labelledby/title, no wrapping `<label>`, and
 * no `<label htmlFor>` in the same file pointing at its id. An id alone names
 * nothing; the old ratchet counted one as a name.
 */
export function unnamedSelects(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const fieldKind = fieldKindOf(sf);
  const htmlFors = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === 'htmlFor' && n.initializer) htmlFors.add(n.initializer.getText().replace(/^\{|\}$/g, ''));
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const visit = (node: ts.Node) => {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open && /^(select|Select)$/.test(open.tagName.getText())) {
      const attrs = open.attributes.properties;
      const names = attrNames(open.attributes);
      const id = attrs.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'id') as ts.JsxAttribute | undefined;
      const idText = id?.initializer?.getText().replace(/^\{|\}$/g, '');
      const named = names.some((n) => n === 'aria-label' || n === 'aria-labelledby' || n === 'title' || n === '...')
        || insideLabel(node) || (idText !== undefined && htmlFors.has(idText)) || namedByField(node, idText, fieldKind);
      if (!named) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: open.getText().replace(/\s+/g, ' ').slice(0, 80) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const NON_INTERACTIVE = /^(div|li|span|tr|td|p|img|section|article|header|footer|figure|ul|main)$/;
/** A handler that only stops propagation, or only closes something (a click-outside layer). */
const NOT_AN_ACTION = [
  /^\{\s*\(?\w*\)?\s*=>\s*\w+\.stopPropagation\(\)\s*\}$/,
  /^\{\s*(close|onClose|dismiss|onDismiss)\s*\}$/,
  /^\{\s*\(\)\s*=>\s*\{?\s*(?:(?:\w+\s*&&\s*)?set\w+\((?:false|null)\);?\s*)+\}?\s*\}$/,
];

/**
 * A row that holds its own buttons cannot be `role="button"` (that role hides
 * its children from assistive technology), so its keyboard path is a native
 * `<button>` inside it with no handler of its own: Enter or Space on it
 * dispatches a click that bubbles to the row's `onClick`.
 */
function bubblesFromAButton(n: ts.Node): boolean {
  let found = false;
  const walk = (c: ts.Node) => {
    if (found) return;
    const o = ts.isJsxElement(c) ? c.openingElement : ts.isJsxSelfClosingElement(c) ? c : null;
    if (o && o.tagName.getText() === 'button' && !o.attributes.properties.some((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'onClick')) found = true;
    else ts.forEachChild(c, walk);
  };
  ts.forEachChild(n, walk);
  return found;
}

/**
 * A non-interactive element that does something on click and cannot be
 * reached or used from the keyboard: no role, no tabIndex, no key handler.
 * (MAIN-F-D06: calendar events, notes, recipes and goal cards opened only on a
 * click.) Click-outside dismiss layers and propagation stops are not actions.
 */
export function clickOnlyElements(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const visit = (n: ts.Node) => {
    const o = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (o && NON_INTERACTIVE.test(o.tagName.getText())) {
      const props = o.attributes.properties;
      const at = (k: string) => props.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === k) as ts.JsxAttribute | undefined;
      const click = at('onClick');
      const handler = click?.initializer?.getText().replace(/\s+/g, ' ') ?? '';
      const reachable = (at('role') && at('tabIndex') && (at('onKeyDown') || at('onKeyUp'))) || bubblesFromAButton(n);
      if (click && !props.some(ts.isJsxSpreadAttribute) && !reachable && !NOT_AN_ACTION.some((re) => re.test(handler))) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, what: `<${o.tagName.getText()} onClick=${handler.slice(0, 50)}>` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
