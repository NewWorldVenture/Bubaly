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

/**
 * Does this file actually TAKE the shared dialog behaviour and attach it?
 *
 * Rewritten for the hook's current signature. It used to look for
 * `const x = useDialogBehavior(...)`, because the hook created and returned the
 * ref. It now takes a caller-owned ref and returns void, so that pattern never
 * matches and this predicate would have quietly answered `false` for every file
 * — which, in the ratchet below, reads as "nothing has been converted" and is
 * exactly the kind of silent inversion a guard is supposed to prevent.
 */
function hasDialogContract(src: string): boolean {
  const taken = src.match(/useDialogBehavior\(\s*(\w+)/);
  return taken !== null && src.includes(`ref={${taken[1]}}`);
}


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

  // The licence is no longer a NAME. A file may declare `aria-modal` if it takes
  // the shared `useDialogBehavior` and attaches the ref it returns — the photo
  // lightbox does, which is how C2-01 was closed without turning full-bleed
  // black chrome into a titled panel. Everything else is on the list below.
  //
  // Fixing the preference centre surfaced that it was not alone: eleven other
  // components declare `aria-modal` themselves, and of those only
  // app/command-bar.tsx calls `.focus()` at all. They are listed rather than
  // fixed in one sweep — each has bespoke layout, and some (the gates) may
  // deliberately refuse Escape, so converting them unexamined would be a worse
  // change than the defect. What this list does is stop the set GROWING, and
  // make each removal a deliberate act.
  //
  // This list may only shrink. Adding to it is the finding.
  // EMPTY, and that is the end state this ratchet existed to reach.
  //
  // All eight remaining entries came off at once. They were the overlays that
  // declared `aria-modal="true"` and implemented none of it — a camera
  // viewfinder, a command palette, three full-screen gates, the orb, the blog
  // launcher, the app shell. The answer for them was not to give each a focus
  // trap but to stop claiming to be modal dialogs, because most of them are
  // not: `aria-modal` tells a screen reader the rest of the page does not
  // exist, and saying that about a launcher or an orb is worse than saying
  // nothing. The attribute is gone from all eight.
  //
  // So the list is empty and the assertion below is now absolute: nothing
  // outside `components/ui/modal.tsx` may declare `aria-modal` without also
  // satisfying `hasDialogContract`. A new entry here needs a reason that
  // survives the paragraph above.
  const HAND_ROLLED: string[] = [];

  // Three have come OFF this list now — contact-list.tsx, rules-editor.tsx and
  // exit-intent.tsx — each for the same reason, and the ratchet forced each
  // removal by failing until it was made.
  //
  // contact-list.tsx came OFF this list: its editor declared
  // `role="dialog" aria-modal="true"` and provided none of what that promises —
  // no Escape, no focus move-in, no trap, no restore. It now uses
  // `useDialogBehavior`, the same hook the photo lightbox uses, so it satisfies
  // `hasDialogContract` and this ratchet requires its removal. That is the
  // mechanism working: the list is not allowed to carry a licence nobody uses.
  function declaresAriaModal(): string[] {
    return [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'app'))]
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').includes('aria-modal');
      })
      .filter((f) => !hasDialogContract(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .sort();
  }

  it('no NEW component hand-rolls aria-modal', () => {
    const unexpected = declaresAriaModal().filter((f) => !HAND_ROLLED.includes(f));
    expect(
      unexpected,
      'these declare aria-modal themselves — use components/ui/modal.tsx, which traps focus, '
      + 'handles Escape and restores focus, rather than promising inertness without providing it',
    ).toEqual([]);
  });

  it('the list shrinks as they are converted, and never lies', () => {
    // An entry that no longer hand-rolls it is a licence nobody is using — the
    // same rule tests/read-error-surfaced.test.ts applies to its exemptions.
    const current = declaresAriaModal();
    const stale = HAND_ROLLED.filter((f) => !current.includes(f));
    expect(stale, 'these no longer declare aria-modal; remove them from HAND_ROLLED').toEqual([]);
  });
});
