// C2-02: fifty-odd `<label>` elements that name nothing, and seventy selects
// with no accessible name.
//
// The shape behind most of them is one thing: a caption over a ROW OF BUTTONS —
// trust levels, days of the week, member pills, emoji chips. `<label>` names a
// form control, by `htmlFor` or by containing it, and a group of buttons is
// neither. A screen reader reads the caption as a stray sentence and then reads
// seven unexplained buttons. `labelledGroup()` in lib/ui/a11y.ts is the fix, and
// it needs no new copy: the caption already exists and is already translated, it
// just stops being a `<label>` and starts being something the group points at.
//
// ── Why this file scans with the TypeScript parser ──────────────────────────
// "Is this control already named?" is a question about ANCESTRY: a `<select>`
// inside a `<label>`, or three levels into a `<Field>` render prop, is named.
// A regular expression cannot see either — a first attempt at this count with
// one returned 128 unnamed selects against the parser's 70, a 45% overcount, and
// it flagged `components/social/studio-form.tsx` where the select is wrapped in
// a label and is perfectly fine.
//
// This audit has already abandoned one guard for exactly that reason: a 25-line
// scan window reported a file clean whose nested buttons were 34 lines further
// down. A number that is believed and wrong is worse than no number, so the
// scanner is tested against fixtures FIRST, in this file, before either count is
// asserted.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFile, scanUnattachedLabels, walkTsx } from './helpers/jsx-a11y-scan';

const ROOT = join(__dirname, '..');
const SELECTS = new Set(['select', 'Select']);

/** Scan one snippet as if it were a file, and report what was flagged. */
function scan(source: string): { selects: number; labels: number } {
  const dir = mkdtempSync(join(tmpdir(), 'bubaly-a11y-'));
  try {
    const file = join(dir, 'fixture.tsx');
    writeFileSync(file, source);
    return {
      selects: scanFile(file, dir, SELECTS).length,
      labels: scanUnattachedLabels(file, dir).length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the scanner is right before its number is believed', () => {
  it('flags a select with no name at all', () => {
    expect(scan('export const A = () => <select><option>a</option></select>;').selects).toBe(1);
  });

  it('does not flag one named by aria-label, an id, or a title', () => {
    expect(scan('export const A = () => <select aria-label="Member" />;').selects).toBe(0);
    expect(scan('export const A = () => <select id="member" />;').selects).toBe(0);
    expect(scan('export const A = () => <select title="Member" />;').selects).toBe(0);
  });

  it('does not flag one a <label> wraps — the case a regex got wrong', () => {
    expect(scan(`
      export const A = () => (
        <label><span>Platform</span><select><option>x</option></select></label>
      );
    `).selects).toBe(0);
  });

  it('does not flag one inside a <Field>, however deep', () => {
    expect(scan(`
      export const A = () => (
        <Field label="Who">{(id) => <div><span><Select /></span></div>}</Field>
      );
    `).selects).toBe(0);
  });

  it('treats a spread as possibly naming, rather than guessing', () => {
    // `{...props}` could carry aria-label. Counting it as a defect would put
    // correct code on the list, which is how a list stops being read.
    expect(scan('export const A = (props) => <select {...props} />;').selects).toBe(0);
  });

  it('flags a caption over a row of buttons', () => {
    expect(scan(`
      export const A = () => (
        <div><label>Trust levels</label><div><button>a</button><button>b</button></div></div>
      );
    `).labels).toBe(1);
  });

  it('does not flag a label that names by htmlFor or by containment', () => {
    expect(scan('export const A = () => <label htmlFor="x">Name</label>;').labels).toBe(0);
    expect(scan('export const A = () => <label>Name<input /></label>;').labels).toBe(0);
  });

  it('does not flag a label that wraps whatever it is handed', () => {
    // components/home/field.tsx is exactly this, and it is correct: the control
    // arrives through `children`, which the parser cannot follow.
    expect(scan('export const A = ({ children }) => <label><span>L</span>{children}</label>;').labels).toBe(0);
  });
});

describe('the counts are bounded, and shrink', () => {
  const files = [...walkTsx(join(ROOT, 'components')), ...walkTsx(join(ROOT, 'app'))];

  it('unattached labels', () => {
    const found = files.flatMap((f) => scanUnattachedLabels(f, ROOT));
    // 52 when measured; 45 after components/guardian/rules-editor.tsx was
    // converted as the worked example — four button rows onto `labelledGroup`,
    // three real inputs onto htmlFor/id, no new copy in either case.
    expect(
      found.length,
      `captions that name nothing:\n${found.map((f) => `${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(45);
  });

  it('selects with no accessible name', () => {
    const found = files.flatMap((f) => scanFile(f, ROOT, SELECTS));
    // A LOWER bound by construction: a select carrying an `id` counts as named
    // even though resolving the matching `htmlFor` would need type information.
    // Smaller than the truth, never larger, which is what a ratchet needs.
    //
    // Not fixed in bulk on purpose. Most of these are toolbar filters with no
    // visible caption, so each needs a NAME, and a name is copy in eleven
    // locales. The obvious shortcut is wrong and worth writing down: the
    // placeholder option is a VALUE, not a name — labelling a control "Whole
    // family" or "All customers" is worse than leaving it unnamed.
    expect(
      found.length,
      `selects with no accessible name:\n${found.map((f) => `${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(70);
  });
});
