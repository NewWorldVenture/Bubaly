import { describe, it, expect } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

// A-19 accessibility + mobile-responsive contract for the shared Modal — the
// interactive primitive used across the whole app. A refactor that silently
// dropped the dialog role, focus trap, Escape handling, focus restore, or the
// mobile safe-area/bottom-sheet layout would regress a11y everywhere at once.
// This locks the WAI-ARIA dialog contract + the mobile layout at the source.
const SRC = readUiSource('components/ui/modal.tsx');

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

  it('closes on Escape and traps Tab focus within the dialog', () => {
    expect(SRC).toMatch(/e\.key === 'Escape'/);
    expect(SRC).toMatch(/onClose\(\)/);
    expect(SRC).toMatch(/e\.key !== 'Tab'/);
    expect(SRC).toMatch(/preventDefault\(\)/);
    // a defined focusable set is what makes the trap real
    expect(SRC).toMatch(/FOCUSABLE|focusables/);
  });

  it('moves focus in on open and restores focus to the trigger on close', () => {
    expect(SRC).toMatch(/previouslyFocused\s*=\s*document\.activeElement/);
    expect(SRC).toMatch(/previouslyFocused\?\.focus\?\.\(\)/);
    // scroll-lock the background while open
    expect(SRC).toMatch(/document\.body\.style\.overflow = 'hidden'/);
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
