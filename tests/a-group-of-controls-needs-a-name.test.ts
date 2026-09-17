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
    //
    // 39 after app/(app)/feedback/feedback-board.tsx, the largest single
    // cluster at 8. Same shape and the same rule: EVERY name already existed on
    // screen as a styled `<label>` pointing at nothing, so each one was read
    // aloud on its own and then met with silence when focus reached the control
    // it named. Five went onto htmlFor/id, and the two rows that are not a
    // single control — the idea/bug buttons and the attachment uploader — onto
    // `labelledGroup`, which points a group at the caption already above it.
    //
    // 29 after components/social/studio-form.tsx and
    // app/(app)/dashboard/social/settings/page.tsx — same rule again, every name
    // already in the catalogue.
    //
    // That pass also corrected the two group captions from the feedback board.
    // A caption that names a SET of controls must not be a `<label>`: a label is
    // for one control, and one with neither `htmlFor` nor a control inside it
    // labels nothing at all. `aria-labelledby` accepts any element, so they are
    // `<span>` now — which is what the worked example in
    // components/guardian/rules-editor.tsx had been doing all along. The
    // scanner was right to keep flagging them, and the arithmetic is what
    // exposed it: eight sites wired, six flags cleared.
    //
    // 17 after guardian/routing-settings, find-time-modal, habits-module and
    // recipes-module — twelve more, and this time all twelve cleared, because
    // the <span>-not-<label> rule was applied from the start rather than
    // discovered afterwards.
    //
    // What is LEFT is a different kind of work, and the drop-off is the point:
    // every cluster converted so far had its name already on screen, in the
    // catalogue, translated. The remainder mostly do not. A control with no
    // visible caption needs a NAME, and a name is copy in eleven locales — so
    // those are owner decisions, not wiring, and the same trap applies as for
    // the selects: a placeholder is a VALUE, not a name.
    //
    // The bound is TIGHTENED with each conversion, deliberately: this assertion
    // is `toBeLessThanOrEqual`, so leaving it high would let the ones just
    // fixed be undone without a single test going red. A ratchet that is not
    // re-tightened is a ceiling, not a ratchet.
    expect(
      found.length,
      `captions that name nothing:\n${found.map((f) => `${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(16);
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
    //
    // 67 after the feedback board: three of its selects (category, impact,
    // audience) carried a visible caption all along and simply were not wired
    // to it, so they cost no copy at all. 66 after feedback-admin's roadmap
    // status, the same shape again.
    //
    // That last one was found by SWEEPING for it rather than by reading: every
    // flagged select was checked for a caption within three lines above. The
    // answer was 2 of 67, which is the useful part — it confirms this note
    // rather than merely asserting it. The remaining 66 really are toolbar
    // filters with nothing on screen to name them.
    //
    // And the sweep's OTHER hit was a false positive worth recording: at
    // app/(app)/dashboard/social/settings/page.tsx the text it matched was
    // `<span>{m.display_name}</span>` — a PERSON'S NAME in a repeated row, not
    // a caption. That select sets one member's social role; naming it after the
    // member would be wrong, and the right name ("Social role") is copy that
    // does not exist yet. Left alone deliberately.
    expect(
      found.length,
      `selects with no accessible name:\n${found.map((f) => `${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(66);
  });
});
