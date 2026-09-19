import { describe, it, expect } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

// A-19 accessibility + mobile-responsive contract for the shared Modal — the
// interactive primitive used across the whole app. A refactor that silently
// dropped the dialog role, focus trap, Escape handling, focus restore, or the
// mobile safe-area/bottom-sheet layout would regress a11y everywhere at once.
// This locks the WAI-ARIA dialog contract + the mobile layout at the source.
//
// The behaviour half now lives in `lib/hooks/use-dialog-behavior.ts`, extracted
// so the photo lightbox — full-bleed black chrome, deliberately not a `<Modal>`
// — gets the same contract from the same definition instead of a second copy.
// These assertions FOLLOW the code into that file rather than being relaxed to
// accommodate it: every property asserted before is asserted now, against
// whichever file carries it, and `BEHAVIOUR` plus `SRC` together are exactly
// what `Modal` renders. An extraction that dropped a property fails here, in
// the same test, with the same message.
const SRC = readUiSource('components/ui/modal.tsx');
const BEHAVIOUR = readFileSync('lib/hooks/use-dialog-behavior.ts', 'utf8');
const SCROLL_LOCK = readFileSync('lib/hooks/use-lock-body-scroll.ts', 'utf8');

// Modal must actually USE the hook; otherwise the assertions below would pass
// against a file the component no longer depends on — a guard reading code that
// nothing runs, which is the failure this repository keeps finding.
const USES_BEHAVIOUR = /useDialogBehavior<HTMLDivElement>\(open, onClose\)/.test(SRC)
  && /from '@\/lib\/hooks\/use-dialog-behavior'/.test(SRC);

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

  it('is wired to the shared dialog behaviour rather than a private copy', () => {
    expect(USES_BEHAVIOUR).toBe(true);
  });

  it('closes on Escape and traps Tab focus within the dialog', () => {
    expect(BEHAVIOUR).toMatch(/e\.key === 'Escape'/);
    // Either spelling of "call the close handler". It reads `onCloseRef.current()`
    // because the effect deliberately does NOT depend on `onClose`'s identity —
    // 92 call sites pass an inline arrow, and depending on it rebuilt the focus
    // trap on every keystroke and moved the caret to the first field. That the
    // CURRENT handler is the one Escape reaches is exercised for real in
    // tests/a-dialog-does-not-steal-the-caret.test.ts, which is a stronger
    // statement than this line can make by matching source.
    expect(BEHAVIOUR).toMatch(/onClose\(\)|onCloseRef\.current\(\)/);
    expect(BEHAVIOUR).toMatch(/e\.key !== 'Tab'/);
    expect(BEHAVIOUR).toMatch(/preventDefault\(\)/);
    // a defined focusable set is what makes the trap real
    expect(BEHAVIOUR).toMatch(/FOCUSABLE|focusables/);
  });

  it('moves focus in on open and restores focus to the trigger on close', () => {
    expect(BEHAVIOUR).toMatch(/previouslyFocused\s*=\s*document\.activeElement/);
    expect(BEHAVIOUR).toMatch(/previouslyFocused\?\.focus\?\.\(\)/);
    // scroll-lock the background while open. The hook composes the shared
    // `useLockBodyScroll`, so the assertion follows it one file further —
    // and that version restores the PREVIOUS overflow rather than clearing it,
    // which is what lets a dialog open on top of the app-lock gate without
    // unlocking the page underneath when it closes.
    expect(BEHAVIOUR).toMatch(/useLockBodyScroll\(open\)/);
    expect(SCROLL_LOCK).toMatch(/body\.style\.overflow = 'hidden'/);
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
