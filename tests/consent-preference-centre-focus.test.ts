import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The privacy preference centre declared `aria-modal="true"` — a promise that the
// rest of the page is inert — while doing none of what makes that true: focus
// never entered the dialog, Tab walked the page behind it, Escape did nothing,
// and on close focus stayed wherever it had been left instead of returning to
// the control that opened it.
//
// For a keyboard or screen-reader user that is WORSE than a plain div, because
// the attribute tells assistive technology to ignore a background the user can
// still reach. And of all the surfaces to get this wrong, a cookie preference
// centre is the one whose entire job is recording a deliberate choice.
//
// components/ui/modal.tsx already implements the whole contract. The rule here is
// therefore not "the consent manager has a focus trap" — it is that nobody
// hand-rolls `aria-modal` again anywhere, since that is how this happened.

const ROOT = join(__dirname, '..');
const consent = readFileSync(join(ROOT, 'components/marketing/consent-manager.tsx'), 'utf8');
const modal = readFileSync(join(ROOT, 'components/ui/modal.tsx'), 'utf8');
// The dialog behaviour (Escape, Tab trap, scroll lock, focus restore) moved to
// `lib/a11y/use-dialog-behavior.ts` so overlays that cannot take the shared
// Modal's chrome can still keep the promise `aria-modal` makes. Assertions that
// read it out of a component's own source now read it from the hook, and the
// component is asserted to DELEGATE. The contract did not weaken.
const DIALOG_HOOK = readFileSync(join(ROOT, 'lib/a11y/use-dialog-behavior.ts'), 'utf8');


function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e)) out.push(p);
  }
  return out;
}

describe('the preference centre is operable by keyboard', () => {
  it('uses the shared Modal instead of hand-rolled dialog markup', () => {
    expect(consent).toContain("from '@/components/ui/modal'");
    expect(consent).toMatch(/<Modal open onClose=\{onClose\}/);
  });

  it('no longer declares aria-modal without implementing it', () => {
    // Comment lines excluded: the file explains the aria-modal it removed, and a
    // naive scan matches its own rationale.
    const code = consent.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('aria-modal');
  });

  it('the Modal it now uses actually implements the contract', () => {
    // Asserting the delegation is worthless if the target does not do the work.
    expect(DIALOG_HOOK, 'focus must move INTO the dialog').toMatch(/\.focus\(\)/);
    expect(modal, 'Modal must delegate the behaviour').toMatch(/useDialogBehavior/);
    expect(DIALOG_HOOK, 'Escape must close').toMatch(/e\.key === 'Escape'/);
    expect(DIALOG_HOOK, 'focus must return to the opener').toMatch(/previouslyFocused\?\.focus/);
    expect(DIALOG_HOOK, 'Tab must be trapped').toMatch(/e\.key !== 'Tab'|items\.length/);
    expect(modal, 'the title must label the dialog by id').toMatch(/aria-labelledby=\{titleId\}/);
  });

  // Fixing the preference centre surfaced that it was not alone: eleven other
  // components declared `aria-modal` themselves, and at the time only
  // app/command-bar.tsx called `.focus()` at all. They were LISTED rather than
  // fixed in one sweep, and the list said "this may only shrink; adding to it
  // is the finding."
  //
  // It has now shrunk to nothing, and the rule that replaced it is better than
  // the list was. `lib/a11y/use-dialog-behavior.ts` was extracted so an overlay
  // with bespoke layout — a camera viewfinder, a command palette, a full-bleed
  // photo viewer — can keep its layout and still keep the promise, without
  // taking Modal's chrome. All eleven now delegate to it.
  //
  // So the question is no longer "did you use Modal?" but "does `aria-modal`
  // mean anything here?", which is a property rather than a membership test and
  // is asserted in both directions by
  // tests/aria-modal-means-what-it-says.test.ts. The photo lightbox (F-D01) is
  // why this matters: it was a full-screen viewer with no dialog role at all,
  // and converting it to Modal was never possible.
  function declaresAriaModal(): string[] {
    return [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'app'))]
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').includes('aria-modal');
      })
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((f) => f !== 'components/ui/modal.tsx')
      .sort();
  }

  it('every component that hand-rolls aria-modal delegates the behaviour', () => {
    const empty = declaresAriaModal().filter(
      (f) => !readFileSync(join(ROOT, f), 'utf8').includes('useDialogBehavior'));
    expect(
      empty,
      'these declare aria-modal themselves and implement none of it — use components/ui/modal.tsx, '
      + 'or useDialogBehavior when the layout cannot take Modal\'s chrome',
    ).toEqual([]);
  });

  it('there is still a set to check (non-vacuity)', () => {
    // The list this replaces could go stale silently. A property cannot, unless
    // the walk stops finding anything — so the walk is asserted too.
    expect(declaresAriaModal().length).toBeGreaterThan(8);
  });
});
