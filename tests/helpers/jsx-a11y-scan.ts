import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

// A component carrying `alt`, `label` or `aria-label` names what wraps it (an
// image in a link, a stat pill with a text label); it is not a bare icon.
const NAMING_PROPS = new Set(['alt', 'label', 'aria-label']);
const isIcon = (n: ts.Node): n is ts.JsxSelfClosingElement =>
  ts.isJsxSelfClosingElement(n) && /^[A-Z]/.test(n.tagName.getText())
  && !n.attributes.properties.some((a) => ts.isJsxAttribute(a) && NAMING_PROPS.has(a.name.getText()));
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
    // Links as well as buttons: an icon-only back link on the send-money page
    // had no name, and this looked only at buttons (P-35). And a <details>
    // disclosure's <summary>: each reminder's snooze clock was announced as an
    // unnamed disclosure, 193 times on a populated reminders page (A11Y-001).
    if (ts.isJsxElement(node) && ['button', 'Button', 'a', 'Link', 'summary'].includes(node.openingElement.tagName.getText())) {
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

/**
 * `<input>` / `<textarea>` (and the house `Input` / `Textarea`) with no name. The
 * name sources are the ones axe's `label` rule accepts: aria-label(ledby), title,
 * a wrapping or pointing `<label>`, the house Field wrapper, or a placeholder.
 * Hidden inputs, inputs out of the accessibility tree and buttons-as-inputs are
 * not form fields a name is read for.
 */
export function unnamedInputs(file: string, text?: string): Site[] {
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
    if (open && /^(input|Input|textarea|Textarea)$/.test(open.tagName.getText())) {
      const attrs = open.attributes.properties;
      const names = attrNames(open.attributes);
      const type = (attrs.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'type') as ts.JsxAttribute | undefined)?.initializer?.getText().replace(/^["'{]|["'}]$/g, '');
      const id = attrs.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'id') as ts.JsxAttribute | undefined;
      const idText = id?.initializer?.getText().replace(/^\{|\}$/g, '');
      const named = names.some((n) => n === 'aria-label' || n === 'aria-labelledby' || n === 'title' || n === 'placeholder' || n === '...')
        || insideLabel(node) || (idText !== undefined && htmlFors.has(idText)) || namedByField(node, idText, fieldKind);
      const cls = (attrs.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'className') as ts.JsxAttribute | undefined)?.initializer?.getText() ?? '';
      // Out of the accessibility tree: `display: none` (Tailwind `hidden`, the
      // file inputs a visible button opens), or a honeypot hidden on purpose.
      const unrendered = /(^|[\s'"`])hidden([\s'"`]|$)/.test(cls) || names.includes('aria-hidden')
        || /tabIndex=\{-1\}/.test(open.getText());
      if (!named && !unrendered && !/^(hidden|submit|button|reset|image)$/.test(type ?? '')) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: open.getText().replace(/\s+/g, ' ').slice(0, 80) });
      }
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
function bubblesFromAButton(n: ts.Node, outerCall: string | null): boolean {
  let found = false;
  const walk = (c: ts.Node) => {
    if (found) return;
    const o = ts.isJsxElement(c) ? c.openingElement : ts.isJsxSelfClosingElement(c) ? c : null;
    if (o && o.tagName.getText() === 'button') {
      const own = o.attributes.properties.find((p) => !ts.isJsxSpreadAttribute(p) && p.name.getText() === 'onClick') as ts.JsxAttribute | undefined;
      // Either it has no handler of its own and its click bubbles to the row,
      // or its own handler performs the row's action itself (typically after
      // stopPropagation, so the row does not run it twice).
      if (!own || (outerCall && own.initializer?.getText().replace(/\s+/g, ' ').includes(outerCall))) { found = true; return; }
    }
    ts.forEachChild(c, walk);
  };
  ts.forEachChild(n, walk);
  return found;
}

/** The call an arrow handler makes — `() => onOpen(note)` gives `onOpen(note)`. */
function handlerCall(handler: string): string | null {
  const m = /^\{\s*\(\s*\)\s*=>\s*\{?\s*([\w.]+\([^()]*\))\s*;?\s*\}?\s*\}$/.exec(handler);
  if (m) return m[1];
  const id = /^\{\s*([\w.]+)\s*\}$/.exec(handler);
  return id ? id[1] : null;
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
      // A backdrop removed from the accessibility tree is a mouse convenience
      // only when the file also gives the keyboard its own way out:
      // useDialogBehavior closes the dialog on Escape.
      const dismissLayer = !!at('aria-hidden') && /useDialogBehavior\s*\(/.test(sf.text);
      const reachable = (at('role') && at('tabIndex') && (at('onKeyDown') || at('onKeyUp')))
        || bubblesFromAButton(n, handlerCall(handler)) || dismissLayer;
      if (click && !props.some(ts.isJsxSpreadAttribute) && !reachable && !NOT_AN_ACTION.some((re) => re.test(handler))) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, what: `<${o.tagName.getText()} onClick=${handler.slice(0, 50)}>` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const CANCELLATION = /\blet\s+(active|current|cancelled|canceled|alive|ignore|live|mounted|disposed)\s*=\s*(true|false)|new AbortController\(|\bgeneration\b|\bisCurrent\(/;
/**
 * `if (fired.current) return; fired.current = true;` makes an effect run once
 * for the component's life, so no later run can supersede it. (A cancel flag
 * there would be wrong: under StrictMode's dev double-invoke the cleanup would
 * cancel the only run, and the second returns early.)
 */
const ONE_SHOT = /if\s*\((\w+)\.current\)\s*return;\s*\1\.current\s*=\s*true;/;

/**
 * An effect that sets state after an `await` or inside a `.then(`, with no
 * way to tell that the effect has gone: no flag, no AbortController, no
 * generation counter. When its dependencies change (a family switch, a new
 * search) or the component unmounts, the old request can still land and
 * overwrite the newer answer (MAIN-F-D09). A setter that runs BEFORE the
 * first await is synchronous and does not count.
 */
/**
 * An element that takes `role="button"` (or a real `<button>`) and ALSO
 * contains another control. A button's children are presentational, so
 * assistive technology is told to ignore the pin and delete buttons inside the
 * card; axe reports it as `nested-interactive`. Found on the notes grid card
 * (P-39), where a merge kept both the card's role and the inner button that
 * replaced it.
 */
export function nestedInteractive(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const CONTROL_TAGS = new Set(['button', 'Button', 'a', 'Link', 'input', 'select', 'textarea', 'Input', 'Select']);
  const tagOf = (n: ts.Node) => (ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null);
  const attrsOf = (n: ts.Node) => (ts.isJsxElement(n) ? n.openingElement.attributes : ts.isJsxSelfClosingElement(n) ? n.attributes : null);
  const roleButton = (n: ts.Node) => {
    const attrs = attrsOf(n);
    return !!attrs?.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === 'role'
      && !!p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text === 'button');
  };
  const containsControl = (root: ts.JsxElement): string | null => {
    let hit: string | null = null;
    const walk = (n: ts.Node) => {
      if (hit) return;
      const tag = tagOf(n);
      // A file input hidden with `className="hidden"` (display: none) takes no
      // focus; a drop zone that opens one is a single control, not two.
      const attrs = attrsOf(n);
      const hidden = !!attrs?.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === 'className'
        && !!p.initializer && ts.isStringLiteral(p.initializer) && /(^|\s)hidden(\s|$)/.test(p.initializer.text));
      if (tag && !hidden && (CONTROL_TAGS.has(tag) || roleButton(n))) { hit = tag; return; }
      ts.forEachChild(n, walk);
    };
    root.children.forEach((c) => walk(c));
    return hit;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && roleButton(node)) {
      const inner = containsControl(node);
      if (inner) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: `role="button" around <${inner}>` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function uncancelledAsyncEffects(file: string, text?: string): Site[] {
  const sf = parse(file, text);
  const out: Site[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /^(useEffect|useLayoutEffect)$/.test(n.expression.getText()) && n.arguments[0]) {
      const body = n.arguments[0].getText();
      const firstAsync = body.search(/\bawait\b|\.then\(/);
      const setAfter = firstAsync >= 0 && /\bset[A-Z]\w*\(/.test(body.slice(firstAsync));
      if (setAfter && !CANCELLATION.test(body) && !ONE_SHOT.test(body)) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, what: body.replace(/\s+/g, ' ').slice(0, 70) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The group and label scanner main added independently (tests/a-group-of-
// controls-needs-a-name.test.ts). Kept whole beside the one above; its two
// private helpers are renamed so the file has one of each name.

// A JSX scanner built on the TypeScript parser rather than on regular
// expressions.
//
// WHY THIS EXISTS AS A PARSER: the question "does this control already have a
// name?" is a question about ANCESTRY — a `<select>` wrapped in a `<label>` is
// named, and one three levels deep inside a `<Field>` render prop is named by
// the label `Field` renders. A regex cannot see either, and this audit has
// already recorded one guard abandoned for exactly that reason: a 25-line scan
// window reported a file clean whose nested buttons were 34 lines further down.
// Shipping a scan whose unsoundness is known is worse than shipping none,
// because the number it prints gets believed.
//
// What it reports is deliberately a LOWER BOUND: a control is flagged only when
// it has no naming mechanism of any kind. A control with an `id` may or may not
// have a `<label htmlFor>` somewhere pointing at it, and resolving that would
// need type information; rather than guess in either direction, `id` counts as
// named and the count stays honest — smaller than the truth, never larger, which
// is what a ratchet needs.

const NAMING_ATTRS = new Set(['aria-label', 'ariaLabel', 'aria-labelledby', 'id', 'title']);
/** JSX elements whose subtree is labelled by the element itself. */
const NAMING_ANCESTORS = new Set(['label', 'Field']);

export type Finding = { file: string; line: number; tag: string };

function attrNameSet(node: ts.JsxOpeningLikeElement): Set<string> {
  const names = new Set<string>();
  for (const a of node.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name) names.add(a.name.getText());
    // `{...props}` could carry anything; treat a spread as "might be named".
    if (ts.isJsxSpreadAttribute(a)) names.add('id');
    // `{...props}` could carry anything; treat a spread as "might be named".

  }
  return names;
}

function jsxTagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

export function scanFile(path: string, root: string, wanted: ReadonlySet<string>): Finding[] {
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const stack: string[] = [];

  const visit = (node: ts.Node): void => {
    let pushed = false;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = jsxTagName(open);

      if (wanted.has(tag) && !stack.some((a) => NAMING_ANCESTORS.has(a))) {
        const attrs = attrNameSet(open);
        if (![...attrs].some((a) => NAMING_ATTRS.has(a))) {
          out.push({
            file: relative(root, path).split(sep).join('/'),
            line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            tag,
          });
        }
      }
      stack.push(tag);
      pushed = true;
    }
    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  };

  visit(src);
  return out;
}

/**
 * `<label>` elements that name nothing: no `htmlFor`, and no form control
 * anywhere in their subtree to be named implicitly.
 *
 * Both halves matter. `<label htmlFor={id}>` names by reference and
 * `<label><input/></label>` names by containment; a label with neither is text
 * that happens to look like a label, and a screen reader reads it as a stray
 * sentence next to an unnamed control.
 */
export function scanUnattachedLabels(path: string, root: string): Finding[] {
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const CONTROLS = new Set(['input', 'select', 'textarea', 'Input', 'Select', 'Textarea']);

  const containsControl = (node: ts.Node): boolean => {
    let found = false;
    const look = (n: ts.Node): void => {
      if (found) return;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const open = ts.isJsxElement(n) ? n.openingElement : n;
        if (CONTROLS.has(open.tagName.getText())) { found = true; return; }
      }
      // `<label>{children}</label>` is a WRAPPER — components/home/field.tsx is
      // exactly this — and it names whatever it is handed at runtime. The parser
      // cannot see through a prop, and guessing "unattached" there would put a
      // correct component on a list of defects, which is how a list stops being
      // read.
      if (ts.isJsxExpression(n) && n.expression && /\bchildren\b/.test(n.expression.getText())) {
        found = true;
        return;
      }
      ts.forEachChild(n, look);
    };
    ts.forEachChild(node, look);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'label') {
      const hasFor = node.openingElement.attributes.properties.some(
        (a) => (ts.isJsxAttribute(a) && a.name?.getText() === 'htmlFor')
          || ts.isJsxSpreadAttribute(a),
      );
      if (!hasFor && !containsControl(node)) {
        out.push({
          file: relative(root, path).split(sep).join('/'),
          line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          tag: 'label',
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(src);
  return out;
}

export function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}
