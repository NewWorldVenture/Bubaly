// scripts/audit-icon-button-labels.mjs — which icon-only buttons have no name.
//
// `<button onClick={…}><Trash2 className="h-4 w-4" /></button>` renders as
// "button" to a screen reader and to voice control. Nothing else. On these lists
// the Edit and Delete buttons sit side by side, so the user cannot tell which one
// deletes the insurance policy. WCAG 4.1.2 Name, Role, Value.
//
// The counting is the whole difficulty, and getting it wrong in the LOOSE
// direction is the trap: a first pass that treats `{t('notes.edit')}` as "not
// text" reports every translated button in the app. Claude-2's earlier
// formulations produced 903 and then 256 that way before the strict one gave 74.
//
// So this is deliberately conservative — it reports a button ONLY when it can see
// no way for the button to have a name:
//
//   * an `aria-label`, `aria-labelledby` or `title` attribute means named;
//   * any non-whitespace JSX text means named;
//   * a `className` containing `sr-only` anywhere inside means named;
//   * and — the important one — ANY `{expression}` child that is not itself pure
//     JSX means named, because `{t('…')}`, `{label}`, `{count}` and
//     `{saving ? 'Saving…' : 'Save'}` all put a name in there and no static
//     analysis should pretend to evaluate them.
//
// What is left is a button whose entire content is icon elements. Those are the
// ones with no name at all.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import ts from 'typescript';

const NAMING_ATTRIBUTES = new Set(['aria-label', 'aria-labelledby', 'title', 'aria-describedby']);

export function sourceFiles() {
  return execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const attributeName = (attr) =>
  ts.isJsxAttribute(attr) ? attr.name.getText() : '';

/** Does this element carry something that gives it an accessible name? */
function hasNamingAttribute(opening) {
  return opening.attributes.properties.some((attr) => {
    if (ts.isJsxSpreadAttribute(attr)) return true; // {...props} may carry one
    return NAMING_ATTRIBUTES.has(attributeName(attr));
  });
}

/** `className="… sr-only …"` on this element. */
function hasScreenReaderText(node, source) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isJsxAttribute(n) && n.name.getText() === 'className' && /sr-only/.test(n.getText(source))) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Every child that could be a name: text, or an expression that is not pure JSX. */
function looksNamed(element, source) {
  let named = false;
  const walk = (node) => {
    if (named) return;
    if (ts.isJsxText(node) && node.getText(source).trim() !== '') { named = true; return; }
    if (ts.isJsxExpression(node)) {
      const inner = node.expression;
      // A bare `{<Icon />}` or `{cond && <Icon />}` is still only an icon; anything
      // else may resolve to text, and guessing is how a scan reports 903.
      if (inner && !isPureJsx(inner)) { named = true; return; }
    }
    ts.forEachChild(node, walk);
  };
  for (const child of element.children ?? []) walk(child);
  return named;
}

/** Whether an expression can only ever produce JSX elements. */
function isPureJsx(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isPureJsx(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return isPureJsx(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return isPureJsx(node.whenTrue) && isPureJsx(node.whenFalse);
  }
  return false;
}

/** Buttons with no accessible name, as [{ file, line, text }]. */
export function auditIconButtonLabels(files = sourceFiles()) {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(source);
        // `<Button>` carries its own label handling and often takes children from
        // a caller; only the raw element is judged here.
        if (tag === 'button'
          && !hasNamingAttribute(node.openingElement)
          && !hasScreenReaderText(node, source)
          && !looksNamed(node, source)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          offenders.push({
            file,
            line,
            text: node.getText(source).replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const offenders = auditIconButtonLabels();
  console.log(`${offenders.length} button(s) with no accessible name:`);
  for (const o of offenders) console.log(`  ${o.file}:${o.line}  ${o.text}`);
  process.exit(offenders.length ? 1 : 0);
}
