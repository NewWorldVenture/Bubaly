import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';

// A11Y-001, WCAG 4.1.2: a button with nothing inside it has a name.
//
// A self-closing <button /> has no text and no icon, so all a screen reader
// can announce is "button". The colour pickers in the new-habit, new-note and
// to-do list forms were rows of these, round swatches whose colour was the
// only sign of what each one chose (axe: button-name, critical, found by
// opening every dialog on the member routes). Each swatch now says its colour
// (shared.colorName.*) and whether it is the one chosen (aria-pressed).
//
// The one kind that needs no name is a click-away backdrop that no one can
// reach: aria-hidden AND tabIndex={-1}, both written literally. The wallet's
// two backdrops were aria-hidden but still in the tab order, so Tab landed on
// a hidden, nameless control (axe: aria-hidden-focus); they leave it now.

const NAMED = ['aria-label', 'aria-labelledby', 'title'];

/** Self-closing <button /> elements with no name that are not an unreachable backdrop. */
function nameless(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === 'button') {
      const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
      const get = (name: string) => attrs.find((a) => a.name.getText(sf) === name);
      const hidden = get('aria-hidden');
      const tab = get('tabIndex');
      const literallyHidden = !!hidden && (!hidden.initializer || hidden.initializer.getText(sf) === '{true}' || hidden.initializer.getText(sf) === '"true"');
      const unreachable = !!tab?.initializer && /^\{-1\}$|^"-1"$/.test(tab.initializer.getText(sf));
      const spread = n.attributes.properties.some(ts.isJsxSpreadAttribute);
      if (!spread && !attrs.some((a) => NAMED.includes(a.name.getText(sf))) && !(literallyHidden && unreachable)) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const files = [...sourceFiles('components'), ...sourceFiles('app')].filter((f) => f.endsWith('.tsx'));

describe('a button with nothing in it has a name', () => {
  it('no self-closing button is nameless, unless it is an unreachable backdrop', () => {
    expect(files.flatMap((f) => { const src = readFileSync(f, 'utf8'); return /<button/.test(src) ? nameless(f, src) : []; })).toEqual([]);
  });

  it('the three colour pickers name each swatch from the shared vocabulary and say which is chosen', () => {
    const habits = readFileSync('components/modules/habits-module.tsx', 'utf8');
    const notes = readFileSync('components/modules/notes-module.tsx', 'utf8');
    const todos = readFileSync('components/modules/todos-module.tsx', 'utf8');
    expect(habits).toContain('aria-label={t(c.labelKey)} aria-pressed={color === c.id}');
    expect(notes).toContain('aria-label={t(c.labelKey)} aria-pressed={selectedColor === c.id}');
    expect(notes).toContain("role=\"group\" aria-label={t('notes.colorLabel')}");
    expect(todos).toContain('aria-label={tr(LIST_COLOR_NAME_KEYS[c])} aria-pressed={color === c}');
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    const keys = [...`${habits}\n${notes}\n${todos}`.matchAll(/'(shared\.colorName\.[a-z]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBe(8 + 9 + 6);
    for (const k of keys) expect(en[k], k).toBeTruthy();
  });

  it('the scanner: a bare or merely hidden button is found; a named one or an unreachable backdrop is not', () => {
    const scan = (jsx: string) => nameless('p.tsx', `export const P = () => (${jsx});`).length;
    expect(scan('<button className="h-5 w-5 rounded-full bg-violet-500" />')).toBe(1);
    expect(scan('<button className="fixed inset-0" aria-hidden onClick={close} />')).toBe(1); // hidden but focusable
    expect(scan('<button className="fixed inset-0" tabIndex={-1} onClick={close} />')).toBe(1); // unreachable but announced
    expect(scan('<button className="fixed inset-0" aria-hidden tabIndex={-1} onClick={close} />')).toBe(0);
    expect(scan('<button aria-label="Violet" aria-pressed={true} className="bg-violet-500" />')).toBe(0);
    expect(scan('<button className="x">Save</button>')).toBe(0); // has content; the icon-only guard judges those
  });
});
