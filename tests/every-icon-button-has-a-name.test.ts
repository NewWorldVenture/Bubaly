// A button a screen reader calls "button" and nothing else.
//
// `<button onClick={…}><Trash2 className="h-4 w-4" /></button>` has no accessible
// name at all. A screen-reader or voice-control user hears "button" — and on these
// lists the Edit and Delete buttons sit side by side, so there is no way to tell
// which one deletes the insurance policy, the financial transaction, the
// immunisation record or the Guardian routing rule. WCAG 4.1.2 Name, Role, Value.
//
// 82 buttons were in that state. The two guards that existed
// (tests/mobile-touch-a11y.test.ts, tests/photos-a11y-labels.test.ts) cover five
// files between them and none of the 82 was in those five — which is why this one
// names no file and sweeps the whole app instead.
//
// The counting is the hard part, and the failure mode is over-reporting: a scan
// that treats `{t('notes.edit')}` as "not text" flags every translated button in
// the product. Claude-2's first two formulations produced 903 and then 256 that
// way. scripts/audit-icon-button-labels.mjs is deliberately conservative — it
// reports a button only when it can see no way for it to have a name at all, and
// in particular treats ANY non-JSX `{expression}` child as a name, because
// `{t('…')}`, `{label}` and `{saving ? 'Saving…' : 'Save'}` all put one there and
// no static analysis should pretend to evaluate them.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditIconButtonLabels } from '../scripts/audit-icon-button-labels.mjs';

const probe = (body: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'bubaly-iconbtn-'));
  try {
    const file = join(directory, 'probe.tsx');
    writeFileSync(file, `export const P = () => (${body});\n`);
    return auditIconButtonLabels([file]).length;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('every icon button has an accessible name', () => {
  it('finds none in the app', () => {
    const offenders = auditIconButtonLabels();
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      'add an aria-label (the a11y.* catalogue keys cover the common actions)',
    ).toEqual([]);
  });

  // The positive controls, and the reason to trust the case above. Every offender
  // the app had is now labelled, so "0 offenders" on its own is equally consistent
  // with a sweep that can no longer see anything.
  it('still catches a bare icon button', () => {
    expect(probe('<button onClick={f}><Trash2 className="h-4 w-4" /></button>')).toBe(1);
  });

  it('still catches one whose only child is a conditional between two icons', () => {
    expect(probe('<button onClick={f}>{busy ? <Loader2 className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}</button>')).toBe(1);
  });

  it('still catches one nested inside a label, where the label names nothing', () => {
    // A <label> gives its name to a form CONTROL, not to a <button> — this is the
    // wallet-activation checkbox, which read as an unnamed button to every
    // assistive technology while looking perfectly labelled on screen.
    expect(probe('<label>Agree<button onClick={f}><Check className="h-3 w-3" /></button></label>')).toBe(1);
  });

  // And the over-reporting it must NOT do. Each of these is a real shape from the
  // app; a scan that flags any of them is the 903-offender version.
  it.each([
    ['an aria-label', '<button aria-label={t("a11y.delete")} onClick={f}><Trash2 className="h-4 w-4" /></button>'],
    ['a title', '<button title="Delete" onClick={f}><Trash2 className="h-4 w-4" /></button>'],
    ['visible text', '<button onClick={f}><Trash2 className="h-4 w-4" /> Delete</button>'],
    ['a translated label', '<button onClick={f}><Trash2 className="h-4 w-4" /> {t("notes.delete")}</button>'],
    ['a conditional label', '<button onClick={f}>{saving ? "Saving…" : "Save"}</button>'],
    ['sr-only text', '<button onClick={f}><Trash2 className="h-4 w-4" /><span className="sr-only">Delete</span></button>'],
    ['a spread that may carry one', '<button {...props}><Trash2 className="h-4 w-4" /></button>'],
    ['a plain variable child', '<button onClick={f}>{label}</button>'],
  ])('does not flag a button with %s', (_why, body) => {
    expect(probe(body)).toBe(0);
  });
});
