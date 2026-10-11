import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 2.4.7 (focus visible). Found by tabbing through all 246
// member routes of a seeded household and comparing each focused element's
// pixels with the same element blurred: these showed no change at all.
//   - The recipes, reminders and grocery filter <select>s: focus:outline-none
//     and nothing in its place.
//   - The rows of /dashboard/more and the profile menu: the browser's own
//     outline was drawn outside the row and clipped by the card's
//     overflow-hidden. The recipe card's button had focus-ring, whose offset
//     ring was clipped by its card and covered by the positioned photo above.
//   - The search pills on grocery, recipes, notes, to-dos, contacts,
//     inventory and photos, and the contact center's area-code field: the
//     input is outline-none inside a bordered pill with no focus style, so
//     only the text caret moved.
//   - A preset avatar in the avatar picker (found by the source guard below):
//     its selection is a ring, and focus added nothing.
// The selects and the area-code field take the app's focus-ring; each pill
// rings when anything in it has focus (focus-within); a row in a clipped
// card rings inside its own box (ring-inset); an avatar's focus is an outline
// outside its selection ring.

const REMOVES = /^(focus:|focus-visible:)?outline-none$/;
const REPLACES = /^(focus-ring|(focus|focus-visible):(ring|border|bg|shadow|underline|outline-(?!none))\S*)$/;
const TEXT_ENTRY = /^(input|textarea)$/;

type Bare = { at: string; file: string; tag: string; line: string; textEntry: boolean };

/** Elements that remove the outline and put nothing in its place, themselves or on a focus-within ancestor. */
function bareFocus(file: string, src: string): Bare[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = src.split('\n');
  const classesOf = (open: ts.JsxOpeningLikeElement): string[] => {
    const attr = open.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText(sf) === 'className');
    const parts: string[] = [];
    const collect = (x: ts.Node) => {
      if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) parts.push(x.text);
      else if (ts.isTemplateExpression(x)) parts.push(x.head.text, ...x.templateSpans.map((s) => s.literal.text));
      ts.forEachChild(x, collect);
    };
    if (attr?.initializer) collect(attr.initializer);
    return parts.join(' ').split(/\s+/).filter(Boolean);
  };
  const attr = (open: ts.JsxOpeningLikeElement, name: string) =>
    open.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText(sf) === name)?.initializer?.getText(sf);
  const found: Bare[] = [];
  const visit = (node: ts.Node, ancestors: ts.JsxOpeningLikeElement[]) => {
    let open: ts.JsxOpeningLikeElement | undefined;
    if (ts.isJsxElement(node)) open = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) open = node;
    if (open) {
      const classes = classesOf(open);
      const tag = open.tagName.getText(sf);
      const programmatic = attr(open, 'tabIndex') === '{-1}' || attr(open, 'role') === '"dialog"' || attr(open, 'aria-modal') !== undefined;
      if (classes.some((c) => REMOVES.test(c)) && !classes.some((c) => REPLACES.test(c)) && !programmatic) {
        const wrapped = ancestors.some((a) => classesOf(a).some((c) => c.startsWith('focus-within:')));
        if (!wrapped) {
          const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
          found.push({ at: `${file}:${line + 1}`, file, tag, line: lines[line].trim(), textEntry: TEXT_ENTRY.test(tag) });
        }
      }
      ts.forEachChild(node, (c) => visit(c, [...ancestors, open!]));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, ancestors));
  };
  visit(sf, []);
  return found;
}

// Text fields that still show only their caret, by file and count: composers,
// command palettes and admin filters, outside this change. Pinned so the list
// can only shrink.
const CARET_ONLY: Record<string, number> = {
  'components/admin/admin-shell.tsx': 1,
  'components/admin/filter-bar.tsx': 1,
  'components/app/command-bar.tsx': 1,
  'components/dashboard/quick-actions.tsx': 1,
  'components/modules/assistant-module.tsx': 2,
  'components/modules/closet-module.tsx': 1,
  'components/modules/contact-center-module.tsx': 1,
  'components/modules/meals-module.tsx': 1,
  'components/modules/messages-module.tsx': 2,
  'components/modules/weather-module.tsx': 1,
  'components/ui/phone-input.tsx': 1,
  'components/wallet/pay-handle-manager.tsx': 1,
};

const files = [...sourceFiles('components'), ...sourceFiles('app')];
const all = files.flatMap((f) => {
  const src = readFileSync(f, 'utf8');
  return /outline-none/.test(src) ? bareFocus(f, src) : [];
});

describe('a focused control shows it', () => {
  it('no control but a text field removes its outline without a replacement', () => {
    expect(all.filter((b) => !b.textEntry).map((b) => `${b.at} <${b.tag}>: ${b.line.slice(0, 140)}`)).toEqual([]);
  });

  it('text fields that keep only their caret are the pinned few', () => {
    const counts: Record<string, number> = {};
    for (const b of all.filter((x) => x.textEntry)) counts[b.file] = (counts[b.file] ?? 0) + 1;
    expect(counts).toEqual(CARET_ONLY);
  });

  it('the sites the sweep found ring on focus', () => {
    const src = (f: string) => readFileSync(f, 'utf8');
    const PILL = 'focus-within:ring-2 focus-within:ring-brand/60 focus-within:ring-offset-2 focus-within:ring-offset-bg';
    for (const f of ['shopping', 'recipes', 'notes', 'todos', 'contacts', 'inventory', 'photos']) {
      expect(src(`components/modules/${f}-module.tsx`), f).toContain(PILL);
    }
    expect(src('components/modules/recipes-module.tsx')).toContain('text-muted focus-ring">');
    expect(src('components/modules/reminders-module.tsx').match(/text-muted focus-ring">/g)).toHaveLength(2);
    expect(src('components/modules/shopping-module.tsx')).toContain('text-muted focus-ring">');
    expect(src('components/modules/contact-center-module.tsx')).toContain('px-3 text-sm focus-ring"');
    const INSET = 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60';
    expect(src('app/(app)/dashboard/more/page.tsx')).toContain(`hover:bg-elevated ${INSET}"`);
    expect(src('components/modules/profile-module.tsx')).toContain(`<Link href={href} className="block ${INSET}">`);
    expect(src('components/modules/profile-module.tsx')).toContain(`className="w-full text-left ${INSET}">`);
    // The recipe card is overflow-hidden under a positioned photo: an offset ring was covered on every side.
    expect(src('components/modules/recipes-module.tsx')).toContain(`className="flex flex-1 flex-col p-4 text-left ${INSET}">`);
    // A preset avatar's selection is already a ring, so its focus is an outline outside it.
    expect(src('components/ui/avatar-picker.tsx')).toContain('focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand');
  });

  it('the scanner: a replacement or a focus-within wrapper counts; a programmatic target is exempt', () => {
    const scan = (jsx: string) => bareFocus('p.tsx', `export const P = () => (${jsx});`).map((b) => b.tag);
    expect(scan(`<select className="focus:outline-none"><option /></select>`)).toEqual(['select']);
    expect(scan(`<select className="focus-ring"><option /></select>`)).toEqual([]);
    expect(scan(`<a className="outline-none focus-visible:ring-2">x</a>`)).toEqual([]);
    expect(scan(`<div className="focus-within:ring-2"><input className="outline-none" /></div>`)).toEqual([]);
    expect(scan(`<div className="border"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div tabIndex={-1} className="outline-none">x</div>`)).toEqual([]);
    expect(scan(`<div role="dialog" className="outline-none">x</div>`)).toEqual([]);
  });
});
