import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// The elements hidden until their group is hovered, read from the source with
// the TypeScript parser, and what is wrong with each. Shared by
// tests/a-control-revealed-on-hover-shows-on-focus-and-touch.test.ts (the
// source rule) and its e2e spec (the same elements, in the app's real CSS).

const FOCUSABLE = /^(button|a|Link|input|select|textarea|Button|ButtonLink)$/;

export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

export type Reveal = { at: string; tag: string; focusable: boolean; classes: string[] };

/** Every element hidden until its group is hovered, with the classes it can carry. */
export function hoverReveals(files: string[]): Reveal[] {
  const found: Reveal[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('group-hover:opacity-100')) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const icons = new Set<string>();
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'lucide-react'
        && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
        for (const e of s.importClause.namedBindings.elements) icons.add(e.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const attr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className');
        if (attr && ts.isJsxAttribute(attr) && attr.initializer && !icons.has(tag)) {
          const parts: string[] = [];
          const collect = (x: ts.Node) => {
            if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) parts.push(x.text);
            else if (ts.isTemplateExpression(x)) parts.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
            ts.forEachChild(x, collect);
          };
          collect(attr.initializer);
          const classes = parts.join(' ').split(/\s+/).filter(Boolean);
          const hidden = classes.includes('opacity-0') || classes.includes('sm:opacity-0');
          const reveal = classes.includes('group-hover:opacity-100') || classes.includes('sm:group-hover:opacity-100');
          if (hidden && reveal) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            found.push({ at: `${file}:${line + 1}`, tag, focusable: FOCUSABLE.test(tag), classes });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** What is wrong with one reveal, if anything. */
export function revealProblem(r: Reveal): string | null {
  const has = (c: string) => r.classes.includes(c);
  if (has('opacity-0')) return 'hidden on touch and narrow screens (bare opacity-0; use opacity-100 sm:opacity-0)';
  // Shown by opacity but not displayed at all below 640px: a phone never gets it.
  if (has('hidden') && r.classes.some((c) => /^sm:(flex|block|inline-flex|inline-block|grid|inline)$/.test(c))) {
    return 'not displayed below 640px (hidden … sm:flex); display it at every width';
  }
  if (has('group-hover:opacity-100')) return 'revealed by hover at every width (use sm:group-hover:opacity-100)';
  if (!has('coarse:opacity-100')) return 'hidden on a wide touch screen (add coarse:opacity-100)';
  if (r.focusable && !has('focus-visible:opacity-100') && !has('focus:opacity-100')) return 'hidden while focused (add focus-visible:opacity-100)';
  if (!r.focusable && !r.classes.some((c) => /^(group-)?focus-within:opacity-100$/.test(c))) {
    return 'hidden while a control inside it is focused (add focus-within:opacity-100)';
  }
  return null;
}
