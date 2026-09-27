import { describe, it, expect } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

// A-19 accessibility + mobile-responsive contract for the shared Modal — the
// interactive primitive used across the whole app. A refactor that silently
// dropped the dialog role, focus trap, Escape handling, focus restore, or the
// mobile safe-area/bottom-sheet layout would regress a11y everywhere at once.
// This locks the WAI-ARIA dialog contract + the mobile layout at the source.
//
// The behaviour half now lives in `lib/a11y/use-dialog-behavior.ts`, extracted
// so the photo lightbox — full-bleed black chrome, deliberately not a `<Modal>`
// — gets the same contract from the same definition instead of a second copy.
// These assertions FOLLOW the code into that file rather than being relaxed to
// accommodate it: every property asserted before is asserted now, against
// whichever file carries it, and `BEHAVIOUR` plus `SRC` together are exactly
// what `Modal` renders. An extraction that dropped a property fails here, in
// the same test, with the same message.
const SRC = readUiSource('components/ui/modal.tsx');
// The dialog BEHAVIOUR moved to a hook so overlays that cannot take Modal's
// chrome can still keep the promise `aria-modal` makes. The contract did not
// weaken — it follows the behaviour to where it lives, and this file asserts
// both halves: that Modal delegates, and that the hook implements.
const HOOK = readFileSync('lib/a11y/use-dialog-behavior.ts', 'utf8');

describe('A-19 shared Modal keeps its a11y + mobile contract', () => {
  it('is a labelled, modal dialog', () => {
    expect(SRC).toMatch(/role="dialog"/);
    expect(SRC).toMatch(/aria-modal="true"/);
    expect(SRC).toMatch(/aria-labelledby=\{titleId\}/);
    expect(SRC).toMatch(/aria-describedby=/);
    // title/description ids are stable + associated via useId
    expect(SRC).toMatch(/useId\(\)/);
    expect(SRC).toMatch(/id=\{titleId\}/);
  });

  it('delegates its dialog behaviour to the shared hook', () => {
    // One implementation, not two. Modal keeping a private copy is how the
    // behaviour became unavailable to everything that needed a different shell.
    expect(SRC).toMatch(/useDialogBehavior\(dialogRef, open, \{ onClose \}\)/);
    expect(SRC).toMatch(/from '@\/lib\/a11y\/use-dialog-behavior'/);
  });

  it('closes on Escape and traps Tab focus within the dialog', () => {
    expect(HOOK).toMatch(/e\.key === 'Escape'/);
    // `onCloseRef.current?.()` counts, and is the correct form. The handler is
    // held in a ref so the trap effect does not depend on its identity — 92 call
    // sites pass an inline arrow, and depending on it rebuilt the trap on every
    // keystroke and threw the caret back to the first field. See
    // tests/a-dialog-does-not-steal-the-caret.
    expect(HOOK).toMatch(/onCloseRef\.current\?\.\(\)|onClose\(\)/);
    expect(HOOK).toMatch(/e\.key !== 'Tab'/);
    expect(HOOK).toMatch(/preventDefault\(\)/);
    // a defined focusable set is what makes the trap real
    expect(HOOK).toMatch(/FOCUSABLE|focusables/);
    // Tab with nothing focusable inside must not walk out into the background
    // this element claims is inert.
    expect(HOOK).toMatch(/items\.length === 0/);
  });

  it('moves focus in on open and restores focus to the trigger on close', () => {
    expect(HOOK).toMatch(/previouslyFocused\s*=\s*document\.activeElement/);
    expect(HOOK).toMatch(/previouslyFocused\?\.focus\?\.\(\)/);
    // scroll-lock the background while open
    expect(HOOK).toMatch(/document\.body\.style\.overflow = 'hidden'/);
  });

  it('keeps the trap for a dialog that has no close (a gate is still modal)', () => {
    // A paywall or lock screen passes no `onClose`: Escape does nothing and the
    // trap still holds. `aria-modal` has to be true even with nothing to close.
    // Same property, current spelling: optional-chaining the ref is exactly
    // "call it only if the caller supplied one".
    expect(HOOK).toMatch(/onCloseRef\.current\?\.\(\)|if \(onClose\) onClose\(\)/);
  });

  it('gives the icon-only close control an accessible name', () => {
    expect(SRC).toMatch(/aria-label="Close dialog"/);
  });

  it('is mobile-responsive: bottom sheet with safe-area inset and dynamic viewport height', () => {
    // bottom sheet on mobile, centered dialog on desktop
    expect(SRC).toMatch(/items-end[\s\S]*sm:items-center/);
    // action row never hides under the home indicator / browser chrome
    expect(SRC).toMatch(/env\(safe-area-inset-bottom\)/);
    // dvh so the sheet fits around mobile browser chrome
    expect(SRC).toMatch(/dvh\]/);
  });
});
