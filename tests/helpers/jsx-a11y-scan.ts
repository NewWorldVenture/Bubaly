import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

function attrNames(node: ts.JsxOpeningLikeElement): Set<string> {
  const names = new Set<string>();
  for (const a of node.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name) names.add(a.name.getText());
    // `{...props}` could carry anything; treat a spread as "might be named".
    if (ts.isJsxSpreadAttribute(a)) names.add('id');
    // `{...props}` could carry anything; treat a spread as "might be named".

  }
  return names;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
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
      const tag = tagName(open);

      if (wanted.has(tag) && !stack.some((a) => NAMING_ANCESTORS.has(a))) {
        const attrs = attrNames(open);
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
