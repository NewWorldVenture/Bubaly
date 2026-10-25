import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contrast, over, THEMES, tokensOf } from './helpers/faded-text';
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
// outside its selection ring. These rings are full --brand: at 60% (the shared
// focus-ring's alpha) they are 1.9–2.4:1 on their grounds, under the 3:1 a
// focus indicator needs (WCAG 1.4.11); see the last test.

const REMOVES = /^(focus:|focus-visible:)?outline-none$/;
const TEXT_ENTRY = /^(input|textarea)$/;

// What a focus style paints, judged per property as the classes combine. A
// ring, border or outline needs a width that is not zero (a ring colour alone
// draws nothing; a border has none unless a class gives it one) and a colour
// that is not transparent or zero alpha; when the focus classes set no colour,
// the element's own applies. A zero width, none, transparent or a zero alpha
// anywhere in a property's focus classes cancels that property. A background
// that changes on focus is not a mark on its own: between neighbouring grounds
// (surface to elevated) it is close to 1:1, under the 3:1 a focus indicator
// needs (WCAG 1.4.11). The only focus background in the source, the skip
// link's, rings as well.
const NOTHING = /(^|-)(0|none|transparent|inherit|hidden)$|-\[0(px)?\]$|\/0$/;
const PROPERTY = /^(ring|border|outline|shadow|bg|underline)(?=$|-)/;
const PLACEMENT = /^(ring|outline|underline)-offset-|^ring-inset$/;
const WIDTH: Record<string, RegExp> = {
  ring: /^ring(-\d+|-\[\d+px\])?$/,
  border: /^border(-[trblxyse])?(-\d+|-\[\d+px\])?$/,
  outline: /^outline(-\d+|-\[\d+px\])?$/,
};
const STYLE = /^(border|outline)-(solid|dashed|dotted|double)$/;
const colour = (prop: string, c: string) => !WIDTH[prop].test(c) && !STYLE.test(c);

function paints(focus: string[], own: string[]): boolean {
  const of = (cs: string[], prop: string) => cs.filter((c) => !PLACEMENT.test(c) && c.match(PROPERTY)?.[1] === prop);
  return ['ring', 'border', 'outline', 'shadow', 'underline'].some((prop) => {
    // outline-none is `outline: 2px solid transparent`: the outline being
    // replaced, and a transparent colour under any outline that sets no other.
    const removed = prop === 'outline' && focus.includes('outline-none') ? ['outline-none'] : [];
    const set = of(focus, prop).filter((c) => c !== 'outline-none');
    if (!set.length || set.some((c) => NOTHING.test(c))) return false;
    if (!(prop in WIDTH)) return true;
    const base = [...of(own, prop), ...removed];
    if (prop === 'ring' && !set.some((c) => WIDTH.ring.test(c))) return false;
    if (prop === 'border' && ![...set, ...base].some((c) => WIDTH.border.test(c) && !NOTHING.test(c))) return false;
    if (!set.some((c) => colour(prop, c)) && base.some((c) => colour(prop, c) && NOTHING.test(c))) return false;
    return true;
  });
}
/** Whether `classes` paint something when the `prefixes` (focus: and focus-visible:, or focus-within:) apply; `focus-ring` is the app's own. */
const paintsOn = (classes: string[], prefixes: string[]) =>
  (prefixes.includes('focus-visible:') && classes.includes('focus-ring')) ||
  paints(
    classes.flatMap((c) => prefixes.filter((p) => c.startsWith(p)).map((p) => c.slice(p.length))),
    classes.filter((c) => !c.includes(':')),
  );
// A dialog takes focus programmatically, as a whole, and says so: role="dialog"
// or "alertdialog", or aria-modal that is literally true. aria-modal={false}
// or a bound value is not a dialog's word for it.
const DIALOG_ROLE = /^["']?(dialog|alertdialog)["']?$|^\{["'](dialog|alertdialog)["']\}$/;
const MODAL_TRUE = /^(["']true["']|\{true\}|\{["']true["']\})$/;

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
  const has = (open: ts.JsxOpeningLikeElement, name: string) =>
    open.attributes.properties.filter(ts.isJsxAttribute).find((a) => a.name.getText(sf) === name);
  const attr = (open: ts.JsxOpeningLikeElement, name: string) => {
    const a = has(open, name);
    return a ? (a.initializer?.getText(sf) ?? '{true}') : undefined;
  };
  const found: Bare[] = [];
  const visit = (node: ts.Node, ancestors: ts.JsxOpeningLikeElement[]) => {
    let open: ts.JsxOpeningLikeElement | undefined;
    if (ts.isJsxElement(node)) open = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) open = node;
    if (open) {
      const classes = classesOf(open);
      const tag = open.tagName.getText(sf);
      const dialog = DIALOG_ROLE.test(attr(open, 'role') ?? '') || MODAL_TRUE.test(attr(open, 'aria-modal') ?? '');
      const programmatic = attr(open, 'tabIndex') === '{-1}' || dialog;
      if (classes.some((c) => REMOVES.test(c)) && !paintsOn(classes, ['focus:', 'focus-visible:']) && !programmatic) {
        const wrapped = ancestors.some((a) => paintsOn(classesOf(a), ['focus-within:']));
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

// Text fields that show only their caret, by file and count. There were 14
// (composers, command palettes, admin and module filters); each now rings
// while it has focus (see the pins below), so the list is empty and a new
// caret-only field fails here.
const CARET_ONLY: Record<string, number> = {};

const files = [...sourceFiles('components'), ...sourceFiles('app')];
const all = files.flatMap((f) => {
  const src = readFileSync(f, 'utf8');
  return /outline-none/.test(src) ? bareFocus(f.replaceAll('\\', '/'), src) : [];
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
    const PILL = 'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2 focus-within:ring-offset-bg';
    for (const f of ['shopping', 'recipes', 'notes', 'todos', 'contacts', 'inventory', 'photos']) {
      expect(src(`components/modules/${f}-module.tsx`), f).toContain(PILL);
    }
    expect(src('components/modules/recipes-module.tsx')).toContain('text-muted focus-ring">');
    expect(src('components/modules/reminders-module.tsx').match(/text-muted focus-ring">/g)).toHaveLength(2);
    expect(src('components/modules/shopping-module.tsx')).toContain('text-muted focus-ring">');
    expect(src('components/modules/contact-center-module.tsx')).toContain('px-3 text-sm focus-ring"');
    const INSET = 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand';
    expect(src('app/(app)/dashboard/more/page.tsx')).toContain(`hover:bg-elevated ${INSET}"`);
    // A profile row's hover paint is on the focused box, under its inset ring: on the
    // full-size child it covered the ring while the row was hovered and focused.
    const profile = src('components/modules/profile-module.tsx');
    expect(profile).toContain(`<Link href={href} className="block transition hover:bg-elevated ${INSET}">{inner}</Link>`);
    expect(profile).toContain(`className="w-full text-left transition hover:bg-elevated ${INSET}">{inner}</button>`);
    const fill = profile.slice(profile.indexOf('const inner = ('), profile.indexOf(')}>', profile.indexOf('const inner = (')));
    expect(fill).toContain(`'flex items-center gap-3 px-4 py-3.5',`);
    expect(fill).not.toMatch(/\bbg-/); // the full-size child paints no background
    // The recipe card is overflow-hidden under a positioned photo: an offset ring was covered on every side.
    expect(src('components/modules/recipes-module.tsx')).toContain(`className="flex flex-1 flex-col p-4 text-left ${INSET}">`);
    // The text fields that showed only their caret: a bordered box rings outside
    // itself; a row flush with a clipped panel rings inside; the assistant's
    // composer turns its own border full brand under its existing glow.
    const RING_INSET = 'focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand';
    for (const [f, box] of [
      ['components/admin/admin-shell.tsx', 'rounded-xl border border-border bg-surface/40 px-3 text-muted'],
      ['components/admin/filter-bar.tsx', 'rounded-lg border border-border bg-surface/60 px-2.5 text-muted'],
      ['components/dashboard/quick-actions.tsx', 'rounded-xl border border-border bg-surface/60 px-3 py-2'],
      ['components/modules/closet-module.tsx', 'rounded-xl border border-border bg-surface/60 px-2 py-1'],
      ['components/modules/contact-center-module.tsx', 'rounded-lg border border-border bg-bg px-2'],
      ['components/modules/meals-module.tsx', 'rounded-xl border border-border bg-surface/60 px-3 py-2'],
      ['components/modules/messages-module.tsx', 'rounded-xl border border-border bg-surface/40 p-2'],
      ['components/modules/weather-module.tsx', 'rounded-xl border border-border bg-surface/60 px-3'],
      ['components/wallet/pay-handle-manager.tsx', 'rounded-lg border border-border bg-bg px-2'],
    ]) expect(src(f), f).toContain(`${box} ${PILL}">`);
    expect(src('components/app/command-bar.tsx')).toContain(`border-b border-border px-4 ${RING_INSET}">`);
    expect(src('components/modules/messages-module.tsx')).toContain(`border-b border-border px-4 py-2 ${RING_INSET}">`);
    expect(src('components/ui/phone-input.tsx')).toContain(`border-b border-border px-3 py-2.5 ${RING_INSET}">`);
    expect(src('components/modules/assistant-module.tsx').match(/"ai-composer flex items-(end|center) gap-2 border p[xy]?-3 [^"]*focus-within:border-brand /g)).toHaveLength(2);
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
    expect(scan(`<div role="alertdialog" aria-modal="true" className="outline-none">x</div>`)).toEqual([]);
    expect(scan(`<div aria-modal className="outline-none">x</div>`)).toEqual([]);
    expect(scan(`<a className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">x</a>`)).toEqual([]);
    expect(scan(`<a className="focus:outline-none focus-visible:outline-2 focus-visible:outline-brand">x</a>`)).toEqual([]);
    expect(scan(`<a className="outline-none focus-visible:ring-[3px]">x</a>`)).toEqual([]);
    expect(scan(`<a className="outline-none ring-transparent focus-visible:ring-2 focus-visible:ring-brand">x</a>`)).toEqual([]);
    expect(scan(`<div className="focus-within:ring-2 focus-within:ring-brand"><input className="outline-none" /></div>`)).toEqual([]);
    expect(scan(`<input className="border border-border outline-none focus:border-brand" />`)).toEqual([]);
    expect(scan(`<a className="sr-only focus:not-sr-only focus:bg-brand focus:outline-none focus:ring-2 focus:ring-brand">x</a>`)).toEqual([]); // the skip link
  });

  it('the scanner: a replacement that paints nothing, or a dialog that is not one, does not count', () => {
    const scan = (jsx: string) => bareFocus('p.tsx', `export const P = ({ open }: any) => (${jsx});`).map((b) => b.tag);
    expect(scan(`<a className="outline-none focus-visible:ring-0">x</a>`)).toEqual(['a']);
    expect(scan(`<button className="outline-none focus-visible:bg-elevated">x</button>`)).toEqual(['button']); // a background alone
    expect(scan(`<div className="focus-within:bg-surface"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<a className="outline-none focus-visible:ring-brand">x</a>`)).toEqual(['a']); // a colour, no width
    expect(scan(`<button className="outline-none focus:shadow-none">x</button>`)).toEqual(['button']);
    expect(scan(`<button className="outline-none focus:border-transparent">x</button>`)).toEqual(['button']);
    expect(scan(`<button className="outline-none focus-visible:outline-0">x</button>`)).toEqual(['button']);
    expect(scan(`<button className="outline-none focus-visible:bg-brand/0">x</button>`)).toEqual(['button']);
    // A width with nothing to paint, or paint with no width, as the classes combine.
    expect(scan(`<a className="outline-none focus-visible:ring-[0px]">x</a>`)).toEqual(['a']);
    expect(scan(`<a className="outline-none focus-visible:ring-2 focus-visible:ring-transparent">x</a>`)).toEqual(['a']);
    expect(scan(`<a className="outline-none focus-visible:ring-2 focus-visible:ring-brand/0">x</a>`)).toEqual(['a']);
    expect(scan(`<a className="outline-none focus:ring-2 focus-visible:ring-0">x</a>`)).toEqual(['a']);
    expect(scan(`<a className="outline-none ring-transparent focus-visible:ring-2">x</a>`)).toEqual(['a']); // the element's own colour
    expect(scan(`<a className="outline-none focus-visible:outline focus-visible:outline-2">x</a>`)).toEqual(['a']); // outline-none's colour is transparent
    expect(scan(`<a className="outline-none focus-visible:outline-2 focus-visible:outline-transparent">x</a>`)).toEqual(['a']);
    expect(scan(`<input className="outline-none focus:border-2 focus:border-transparent" />`)).toEqual(['input']);
    expect(scan(`<input className="outline-none focus:border-brand" />`)).toEqual(['input']); // a border colour with no border
    expect(scan(`<div className="focus-within:ring-[0px]"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="focus-within:ring-2 focus-within:ring-transparent"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="focus-within:ring-2 focus-within:ring-brand/0"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="ring-transparent focus-within:ring-2"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="focus-within:outline-none"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="opacity-0 focus-within:opacity-100"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<div className="focus-within:ring-0"><input className="outline-none" /></div>`)).toEqual(['input']);
    expect(scan(`<button aria-modal={false} className="outline-none">x</button>`)).toEqual(['button']);
    expect(scan(`<button aria-modal={open} className="outline-none">x</button>`)).toEqual(['button']);
    expect(scan(`<div role={open ? 'dialog' : undefined} className="outline-none">x</div>`)).toEqual(['div']);
    expect(scan(`<div role="region" className="outline-none">x</div>`)).toEqual(['div']);
  });

  // The grounds each new ring is drawn against, composited as the browser
  // paints them: the More and profile rows (bg-surface/40 on the page, and
  // bg-elevated under hover), the recipe card (.glass-card, surface at 72%),
  // the search pills (their ring-offset is --bg; outside is the page, a
  // glass card, or the inventory's bg-brand/5 panel).
  for (const [theme, selector] of THEMES) {
    it(`${theme}: the new rings read at 3:1 on every ground they are drawn on; at 60% they did not`, () => {
      const t = tokensOf(selector);
      const grounds: Record<string, number[]> = {
        bg: t.bg,
        'row (surface/40)': over(t.surface, 0.4, t.bg),
        'row hovered (elevated)': t.elevated,
        'glass card (surface/72)': over(t.surface, 0.72, t.bg),
        'inventory panel (brand/5)': over(t.brand, 0.05, t.bg),
      };
      for (const [name, g] of Object.entries(grounds)) {
        expect(contrast(t.brand, g), `ring-brand on ${name}`).toBeGreaterThanOrEqual(3);
        expect(contrast(over(t.brand, 0.6, g), g), `control: ring-brand/60 on ${name}`).toBeLessThan(3);
      }
    });
  }
});
