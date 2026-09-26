import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clickOnlyElements, detachedLabels, sourceFiles, unnamedIconButtons, unnamedSelects } from './helpers/jsx-a11y-scan';

// A11Y-002 counted the detached-label finding (MAIN-F-D02) as fixed because
// `jsx-a11y/label-has-associated-control` reported a clean tree. The rule treats
// any `{expression}` child as a possible nested control, so it never reports
// `<label>{t('…')}</label>`, and almost every label in this app is exactly
// that. Measured: 50 labels attached to nothing, including the public survey
// and gift forms. A11Y-003 is the same blindness for buttons: 83 icon-only
// buttons with no name, 29 of them delete buttons, which a screen reader
// announced as "button". Both are now zero and must stay zero.

const files = sourceFiles();

describe('every control in the app has a name', () => {
  it('scans the real tree (guards the guard)', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('no icon-only button is unnamed (A11Y-003)', () => {
    const sites = files.flatMap((f) => unnamedIconButtons(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites, 'give each an aria-label from the iconAction.* keys, or a visible label').toEqual([]);
  });

  it('no select is unnamed (MAIN-F-D03)', () => {
    // An id counts only if a <label htmlFor> in the file, or the house Field
    // wrapper, actually points at it; the old ratchet counted any id as a name.
    const sites = files.flatMap((f) => unnamedSelects(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites, 'give each an aria-label from the fieldName.* keys, or a label that points at it').toEqual([]);
  });

  it('nothing answers only a mouse click (MAIN-F-D06)', () => {
    const sites = files.flatMap((f) => clickOnlyElements(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites, 'use a <button>, or role="button" + tabIndex={0} + onKeyDown={activateOnKey(…)}').toEqual([]);
  });

  it('no <label> is attached to nothing (A11Y-002, MAIN-F-D02)', () => {
    const sites = files.flatMap((f) => detachedLabels(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites, 'use htmlFor + id for one control, or a <span id> naming a role="group"').toEqual([]);
  });
});

describe('the scanner sees what the lint rule does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-scan-'));
  const scan = (body: string) => {
    const file = join(dir, `f${Math.random().toString(36).slice(2)}.tsx`);
    writeFileSync(file, `export function F({ tr, on, children }: any) {\n  return (<div>${body}</div>);\n}\n`);
    return { buttons: unnamedIconButtons(file).length, labels: detachedLabels(file).length };
  };

  it('a translated label next to its input is detached (the case the lint rule passes)', () => {
    expect(scan(`<label>{tr('x')}</label><input />`).labels).toBe(1);
    expect(scan(`<label htmlFor="a">{tr('x')}</label><input id="a" />`).labels).toBe(0);
    expect(scan(`<label>{tr('x')}<input /></label>`).labels).toBe(0);
    expect(scan(`<label className="c">{children}</label>`).labels).toBe(0);
  });

  it('an icon-only button is unnamed, however the icon is chosen', () => {
    expect(scan(`<button onClick={on}><Trash2 /></button>`).buttons).toBe(1);
    expect(scan(`<button onClick={on}>{on ? <Pin /> : <PinOff />}</button>`).buttons).toBe(1);
    expect(scan(`<button onClick={on}>\n  {on && <Check />}\n</button>`).buttons).toBe(1);
  });

  it('a select is named by a label that points at its id, not by the id alone', () => {
    const selects = (body: string) => {
      const file = join(dir, `s${Math.random().toString(36).slice(2)}.tsx`);
      writeFileSync(file, `export function F({ tr }: any) {\n  return (<div>${body}</div>);\n}\n`);
      return unnamedSelects(file).length;
    };
    expect(selects(`<select id="a" />`)).toBe(1);
    expect(selects(`<label htmlFor="a">{tr('x')}</label><select id="a" />`)).toBe(0);
    expect(selects(`<select aria-label={tr('fieldName.status')} />`)).toBe(0);
    expect(selects(`<label><span>{tr('x')}</span><select /></label>`)).toBe(0);
  });

  it('a click-only element is caught; a dismiss layer or a keyboard-ready one is not', () => {
    const clicks = (body: string) => {
      const file = join(dir, `c${Math.random().toString(36).slice(2)}.tsx`);
      writeFileSync(file, `export function F({ on, close, setOpen, k }: any) {\n  return (<div>${body}</div>);\n}\n`);
      return clickOnlyElements(file).length;
    };
    expect(clicks(`<div onClick={() => on(1)}>open</div>`)).toBe(1);
    expect(clicks(`<li onClick={on}>open</li>`)).toBe(1);
    expect(clicks(`<div onClick={() => on(1)} role="button" tabIndex={0} onKeyDown={k}>open</div>`)).toBe(0);
    expect(clicks(`<div onClick={() => setOpen(false)} />`)).toBe(0);
    expect(clicks(`<div onClick={close} />`)).toBe(0);
    expect(clicks(`<div onClick={(e) => e.stopPropagation()}><button>x</button></div>`)).toBe(0);
  });

  it('a name from aria-label, title, visible text or a wrapping label counts', () => {
    expect(scan(`<button aria-label={tr('iconAction.delete')}><Trash2 /></button>`).buttons).toBe(0);
    expect(scan(`<button title="x"><Trash2 /></button>`).buttons).toBe(0);
    expect(scan(`<button><Trash2 /> {tr('delete')}</button>`).buttons).toBe(0);
    expect(scan(`<label><button role="checkbox" aria-checked={on}>{on && <Check />}</button><span>{tr('agree')}</span></label>`).buttons).toBe(0);
  });
});
