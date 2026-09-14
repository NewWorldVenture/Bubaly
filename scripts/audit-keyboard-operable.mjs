// scripts/audit-keyboard-operable.mjs — which click targets a keyboard cannot reach.
//
//   <div onClick={() => setSelected(e)} className="cursor-pointer …">
//
// A mouse opens that. A keyboard does not: the element is not focusable, so Tab
// never lands on it and Enter never fires. WCAG 2.1.1 Keyboard, Level A. It is
// also announced as plain text, so a screen-reader user is not told there is
// anything to activate at all.
//
// Reporting this honestly means separating three things that all look alike in a
// grep for `onClick` on a `<div>`, and only the first is a defect:
//
//   1. AN ACTIVATION. Clicking it opens, selects, adds or uploads something.
//      Nothing else on the page does that job. This is the defect.
//   2. A DISMISSAL. Clicking it only closes something already open — the
//      backdrop behind a modal, the invisible sheet behind an open dropdown.
//      Nothing is activated, and the keyboard's equivalent is Escape, not Tab.
//      Making these focusable would be worse: it puts a tab stop with no purpose
//      in front of every user.
//   3. A PROPAGATION STOP. `onClick={(e) => e.stopPropagation()}` on a wrapper
//      inside a clickable row. It exists so that clicking the row's buttons does
//      not also open the row. A keyboard user activates those buttons directly
//      and never traverses it.
//
// The three exemptions below are therefore STRUCTURAL — derived from the code —
// and not a list of files. A filename allowlist would go stale the first time
// one of those files gained a real control, and nothing would say so.
//
// The dismissal exemption carries a condition, because "the keyboard's
// equivalent is Escape" is only true where Escape is actually wired: a file with
// a mouse-only dismissal and no Escape handler anywhere is still reported. That
// is coarse — it cannot tell which of several dismissables the handler serves —
// and it is deliberately coarse in the direction that reports too much rather
// than too little.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import ts from 'typescript';

/** Elements that are focusable and Enter/Space-activatable on their own. */
const NATIVELY_OPERABLE = new Set([
  'button', 'a', 'input', 'select', 'textarea', 'summary', 'option', 'label', 'details', 'area', 'iframe',
]);

const KEY_HANDLERS = ['onKeyDown', 'onKeyUp', 'onKeyPress'];

export function sourceFiles() {
  return execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Does this handler body do nothing but turn things off? */
function onlyDismisses(expression) {
  if (!expression) return false;
  const calls = [];
  let sawOther = false;
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
      // Only the ARGUMENTS matter; a callee like `setOpen` is not itself a value.
      for (const arg of node.arguments) walk(arg);
      return;
    }
    // A bare identifier reference as the whole body (`onClick={onEdit}`) is an
    // unknown handler, not a dismissal.
    ts.forEachChild(node, walk);
  };
  walk(expression);
  if (calls.length === 0) return false;
  for (const call of calls) {
    // A call with NO arguments turns nothing off — `inputRef.current?.click()`
    // opens a file picker. An earlier version of this rule looked only for a
    // non-off argument and so read every zero-argument call as a dismissal,
    // which quietly exempted the three upload dropzones.
    if (call.arguments.length === 0) { sawOther = true; break; }
    for (const arg of call.arguments) {
      const isOff = arg.kind === ts.SyntaxKind.FalseKeyword
        || arg.kind === ts.SyntaxKind.NullKeyword
        || (ts.isIdentifier(arg) && arg.text === 'undefined');
      if (!isOff) { sawOther = true; break; }
    }
    if (sawOther) break;
  }
  return !sawOther;
}

/** `onClick={(e) => e.stopPropagation()}` and nothing else. */
function onlyStopsPropagation(expression, source) {
  if (!expression) return false;
  const text = expression.getText(source);
  if (!/stopPropagation/.test(text)) return false;
  // More than one statement means it also does something.
  return !/;/.test(text.replace(/;\s*}\s*$/, ''));
}

/** Interactive descendants — the reason a wrapper must not take role="button". */
const INTERACTIVE_COMPONENT = /^(Button|Link|IconButton|Select|Input|Textarea|Checkbox|Switch|Toggle)/;

function interactiveDescendants(element, source) {
  const found = new Set();
  const walk = (node) => {
    if (node !== element) {
      const opening = ts.isJsxElement(node) ? node.openingElement
        : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening) {
        const tag = opening.tagName.getText(source);
        // A `className="hidden"` file input is display:none — already out of the
        // accessibility tree and not a focus stop, so it is not a descendant
        // whose semantics could be erased.
        //
        // `hidden sm:inline-flex` is NOT that: it is hidden on a phone and shown
        // on a laptop. Reading a bare /hidden/ here made the contacts row look
        // like a leaf when it holds a call button and a link, which is the one
        // distinction that decides whether the row may take role="button".
        const hidden = opening.attributes.properties.some((a) => {
          if (!ts.isJsxAttribute(a) || a.name.getText() !== 'className') return false;
          const value = a.getText(source);
          if (!/\bhidden\b/.test(value)) return false;
          return !/\b(?:sm|md|lg|xl|2xl|coarse|fine|print):(?:block|flex|inline|inline-flex|inline-block|grid|table|contents)\b/.test(value);
        });
        if (!hidden && (NATIVELY_OPERABLE.has(tag) || INTERACTIVE_COMPONENT.test(tag))) found.add(tag);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(element);
  return [...found];
}

/** The function names a handler calls, ignoring event plumbing. */
function calledNames(expression, source) {
  const names = new Set();
  if (!expression) return names;
  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.getText(source)
        : ts.isIdentifier(callee) ? callee.text : '';
      if (name && name !== 'stopPropagation' && name !== 'preventDefault') names.add(name);
    }
    if (ts.isIdentifier(node) && ts.isJsxExpression(node.parent)) names.add(node.text);
    ts.forEachChild(node, walk);
  };
  walk(expression);
  return names;
}

/**
 * Is the wrapper's action ALSO on a real <button> inside it?
 *
 * That is the WAI card pattern: the row keeps its onClick as a mouse
 * convenience, and a real button over the content region carries the focus, the
 * name and Enter/Space. It is the right shape wherever the row also holds action
 * buttons, because role="button" on such a row has presentational children — ARIA
 * says assistive technology may drop the semantics of everything inside it, which
 * would silence the very Edit and Delete labels that make the row usable.
 *
 * Checked by comparing which functions each handler calls, not by shape: a nested
 * button often has to add stopPropagation (the contacts row toggles, so firing
 * twice would cancel itself), and stopPropagation and preventDefault are ignored
 * here for exactly that reason.
 */
function actionIsAlsoOnAButton(element, wrapperClick, source) {
  const wanted = calledNames(wrapperClick, source);
  if (wanted.size === 0) return false;
  let found = false;
  const walk = (node) => {
    if (found) return;
    if (node !== element) {
      const opening = ts.isJsxElement(node) ? node.openingElement
        : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening) {
        const tag = opening.tagName.getText(source);
        if (tag === 'button' || tag === 'a' || /^Button/.test(tag)) {
          for (const attr of opening.attributes.properties) {
            if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'onClick') continue;
            const inner = attr.initializer && ts.isJsxExpression(attr.initializer)
              ? attr.initializer.expression : attr.initializer;
            const names = calledNames(inner, source);
            if ([...wanted].every((n) => names.has(n))) { found = true; return; }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(element);
  return found;
}

export function auditKeyboardOperable(files = sourceFiles()) {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // Coarse, per-file: is Escape handled anywhere in this component file?
    const escapeHandled = /['"]Escape['"]/.test(text);

    const visit = (node) => {
      const opening = ts.isJsxElement(node) ? node.openingElement
        : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening) {
        const tag = opening.tagName.getText(source);
        // Lowercase tag = a real DOM element. A component named `<Row>` forwards
        // its props somewhere this scan cannot follow.
        if (/^[a-z]/.test(tag) && !NATIVELY_OPERABLE.has(tag)) {
          let spread = false;
          const attrs = new Map();
          for (const attr of opening.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) { spread = true; continue; }
            attrs.set(attr.name.getText(), attr.initializer ?? null);
          }
          const click = attrs.get('onClick');
          const operable = attrs.has('tabIndex') && KEY_HANDLERS.some((k) => attrs.has(k));

          if (click && !operable && !spread) {
            const inner = ts.isJsxExpression(click) ? click.expression : click;
            const children = ts.isJsxElement(node)
              ? node.children.filter((c) => !(ts.isJsxText(c) && c.getText(source).trim() === ''))
              : [];
            const className = attrs.has('className') ? attrs.get('className').getText(source) : '';

            const isStop = onlyStopsPropagation(inner, source);
            // `aria-hidden` removes the element from the accessibility tree, so
            // it is neither a focus stop nor something a screen reader announces.
            // That is exactly right for a modal scrim and is how components/ui/
            // modal.tsx writes one; it is also airtight, where "the handler is
            // named onClose" would only be a guess about a bare identifier.
            const isHidden = attrs.has('aria-hidden');
            // Never for a dismissal: the photos lightbox backdrop dismisses with
            // setLightboxIdx(null) and its Previous/Next buttons NAVIGATE with the
            // same setter, so this exemption matched and hid a backdrop with no
            // Escape handler. A dismissal is judged by the Escape rule alone.
            const delegated = !onlyDismisses(inner) && actionIsAlsoOnAButton(node, inner, source);
            // An empty inset-0 sheet has nothing to activate; a dismissal with
            // children is exempt only where Escape is wired in the same file.
            const isCatcher = children.length === 0 && /inset-0/.test(className);
            const isDismissal = onlyDismisses(inner) && (isCatcher || escapeHandled);

            if (!isStop && !isDismissal && !isHidden && !delegated) {
              offenders.push({
                file,
                line: source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1,
                tag,
                interactive: interactiveDescendants(node, source),
                dismissesWithoutEscape: onlyDismisses(inner) && !escapeHandled,
                text: opening.getText(source).replace(/\s+/g, ' ').slice(0, 110),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const offenders = auditKeyboardOperable();
  console.log(`${offenders.length} click target(s) a keyboard cannot operate:`);
  for (const o of offenders) {
    const why = o.dismissesWithoutEscape
      ? 'dismisses, but no Escape handler in this file'
      : o.interactive.length
        ? `has interactive descendants [${o.interactive.join(', ')}] — needs a nested <button>, not role="button"`
        : 'leaf — needs role="button" + tabIndex + onKeyDown, or a real <button>';
    console.log(`  ${o.file}:${o.line} <${o.tag}> — ${why}`);
  }
  process.exit(offenders.length ? 1 : 0);
}
