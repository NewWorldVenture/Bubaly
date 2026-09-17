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
// The contract itself was extracted to `useDialogBehavior` so the full-screen
// overlays that are deliberately not `<Modal>` share one definition of it. The
// assertion below follows the code there rather than being dropped.
const behaviour = readFileSync(join(ROOT, 'lib/hooks/use-dialog-behavior.ts'), 'utf8');

/**
 * Does this file carry the dialog contract, rather than merely claiming it?
 *
 * It must take a ref from `useDialogBehavior` AND attach that same ref to an
 * element — a hook whose ref never reaches the DOM traps nothing. This is what
 * `aria-modal` is licensed by from here on, which is strictly stronger than the
 * rule it replaces: `components/ui/modal.tsx` used to be exempt BY NAME, with
 * nothing checking that it still did the work.
 */
function hasDialogContract(src: string): boolean {
  const taken = src.match(/const\s+(\w+)\s*=\s*useDialogBehavior\b/);
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
    expect(hasDialogContract(modal), 'Modal must take the shared behaviour AND attach its ref').toBe(true);
    expect(behaviour, 'focus must move INTO the dialog').toMatch(/\.focus\(\)/);
    expect(behaviour, 'Escape must close').toMatch(/e\.key === 'Escape'/);
    expect(behaviour, 'focus must return to the opener').toMatch(/previouslyFocused\?\.focus/);
    expect(behaviour, 'Tab must be trapped').toMatch(/e\.key === 'Tab'|items\.length/);
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
  const HAND_ROLLED = [
    'components/app/account-closed-gate.tsx',
    'components/app/ai-orb.tsx',
    'components/app/app-lock-gate.tsx',
    'components/app/app-shell.tsx',
    'components/app/blog-launcher.tsx',
    'components/app/command-bar.tsx',
    'components/app/trial-paywall-gate.tsx',
    'components/ui/camera-capture.tsx',
  ];

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
