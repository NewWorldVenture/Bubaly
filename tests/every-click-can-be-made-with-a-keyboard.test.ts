// A control that a mouse can operate and a keyboard cannot.
//
//   <div onClick={() => setSelected(e)} className="cursor-pointer …">
//
// The calendar event chip in all five views, the note row and card, the photo
// tile and row, the recipe card, the contact row, the empty meal slot and three
// upload dropzones were all written that way. None was focusable, so Tab never
// reached them and Enter never fired: a keyboard-only or switch-access user could
// see the events and open none of them. WCAG 2.1.1 Keyboard, Level A.
//
// The interesting part is what the fix may NOT be. The obvious one — put
// role="button" tabIndex={0} onKeyDown on the row — is wrong wherever the row also
// holds action buttons, because role="button" has PRESENTATIONAL CHILDREN: ARIA
// says assistive technology may drop the semantics of everything inside it. On the
// note row that would have silenced the Pin, Copy and Delete buttons whose labels
// the previous pass had just added. So those rows take a real nested <button> over
// their content region instead, and keep the row's onClick as a mouse convenience.
//
// scripts/audit-keyboard-operable.mjs draws that distinction and exempts the three
// things that look identical to a grep but are not defects: a dismissal (a modal
// scrim, the sheet behind an open dropdown — nothing is activated and the keyboard's
// equivalent is Escape, not Tab), a propagation stop, and an aria-hidden element.
// Every exemption is structural, derived from the code, because a list of filenames
// would go stale the first time one of those files gained a real control and nothing
// would say so.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditKeyboardOperable } from '../scripts/audit-keyboard-operable.mjs';

const probe = (body: string, extra = '') => {
  const directory = mkdtempSync(join(tmpdir(), 'bubaly-kbd-'));
  try {
    const file = join(directory, 'probe.tsx');
    writeFileSync(file, `${extra}export const P = () => (${body});\n`);
    return auditKeyboardOperable([file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('every click target can be reached with a keyboard', () => {
  it('finds none in the app', () => {
    const offenders = auditKeyboardOperable();
    expect(
      offenders.map((o) => `${o.file}:${o.line} <${o.tag}>`
        + (o.interactive.length ? ` [has ${o.interactive.join(', ')}]` : '')),
      'a leaf takes role="button" + tabIndex + onKeyDown; a row that holds its own '
      + 'buttons takes a nested <button> over its content instead, because '
      + 'role="button" has presentational children',
    ).toEqual([]);
  });

  // The positive controls. Every real offender is fixed, so "0 offenders" is by
  // itself equally consistent with a sweep that has gone blind — these plant one
  // known-bad shape each and require it to be seen.
  describe('sees a mouse-only control', () => {
    it('a bare div onClick', () => {
      expect(probe(`<div onClick={() => open(x)}>Open</div>`)).toHaveLength(1);
    });

    it('a div with tabIndex but no key handler — focusable, still not activatable', () => {
      expect(probe(`<div onClick={() => open(x)} tabIndex={0}>Open</div>`)).toHaveLength(1);
    });

    it('a div with a key handler but no tabIndex — Tab never lands on it', () => {
      expect(probe(`<div onClick={() => open(x)} onKeyDown={k}>Open</div>`)).toHaveLength(1);
    });

    it('a row that holds a button, and reports that it does', () => {
      const [offender] = probe(
        `<div onClick={() => open(x)}><span>Note</span><button onClick={del} aria-label="Delete">X</button></div>`,
      );
      expect(offender.interactive).toContain('button');
    });

    it('a table row', () => {
      expect(probe(`<tr onClick={() => open(x)}><td>1</td></tr>`)).toHaveLength(1);
    });

    it('a dismissal in a file with no Escape handler anywhere', () => {
      const [offender] = probe(`<div onClick={() => setOpen(false)}><p>Sheet</p></div>`);
      expect(offender.dismissesWithoutEscape).toBe(true);
    });
  });

  // The negative controls, which matter more: each is a shape the sweep must NOT
  // report, and each is a way this kind of scan turns into noise nobody reads.
  describe('does not report', () => {
    it('a real button', () => {
      expect(probe(`<button onClick={() => open(x)}>Open</button>`)).toEqual([]);
    });

    it('an anchor', () => {
      expect(probe(`<a href="/x" onClick={() => open(x)}>Open</a>`)).toEqual([]);
    });

    it('a label, which forwards its click to its own control', () => {
      expect(probe(`<label onClick={() => open(x)}><input type="checkbox" /></label>`)).toEqual([]);
    });

    it('a div that is focusable AND has a key handler', () => {
      expect(probe(
        `<div onClick={() => open(x)} onKeyDown={k} role="button" tabIndex={0}>Open</div>`,
      )).toEqual([]);
    });

    it('an empty inset-0 sheet behind a dropdown — a tab stop there has no purpose', () => {
      expect(probe(`<div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />`)).toEqual([]);
    });

    it('an aria-hidden modal scrim', () => {
      expect(probe(`<div className="absolute inset-0" onClick={onClose} aria-hidden />`)).toEqual([]);
    });

    it('a dismissal where Escape is wired in the same file', () => {
      expect(probe(
        `<div className="wrap" onClick={() => setMenu(null)}><p>x</p></div>`,
        `const k = (e) => { if (e.key === 'Escape') setMenu(null); };\n`,
      )).toEqual([]);
    });

    it('a wrapper that only stops propagation', () => {
      expect(probe(`<div onClick={(e) => e.stopPropagation()}><button>A</button></div>`)).toEqual([]);
    });

    it('a row whose action is also on a nested button — the WAI card pattern', () => {
      expect(probe(
        `<div onClick={() => onOpen(note)}>`
        + `<button onClick={(e) => { e.stopPropagation(); onOpen(note); }}>Title</button>`
        + `<button onClick={del} aria-label="Delete">X</button>`
        + `</div>`,
      )).toEqual([]);
    });

    it('a component, whose props this scan cannot follow', () => {
      expect(probe(`<Row onClick={() => open(x)}>Open</Row>`)).toEqual([]);
    });

    it('an element spreading props that may already carry the handling', () => {
      expect(probe(`<div {...rest} onClick={() => open(x)}>Open</div>`)).toEqual([]);
    });
  });

  // The nested-button exemption is the one with a way to be too generous, and both
  // of these are ways it was.
  describe('the nested-button exemption', () => {
    it('requires the SAME action, not merely the presence of some button', () => {
      expect(probe(
        `<div onClick={() => onOpen(note)}><button onClick={() => onDelete(note)}>Delete</button></div>`,
      )).toHaveLength(1);
    });

    // The photos lightbox backdrop dismissed with setLightboxIdx(null) while its
    // Previous and Next buttons NAVIGATED with the same setter — so the exemption
    // matched and hid a full-screen overlay that had no Escape handler at all. A
    // dismissal is judged by the Escape rule alone.
    it('does not cover a dismissal that shares a setter with a nested control', () => {
      const [offender] = probe(
        `<div onClick={() => setIdx(null)}>`
        + `<button onClick={(e) => { e.stopPropagation(); setIdx((i) => i - 1); }}>Prev</button>`
        + `</div>`,
      );
      expect(offender?.dismissesWithoutEscape).toBe(true);
    });
  });
});
