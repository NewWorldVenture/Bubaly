import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 11 — overlays; Phase 8 — safe areas):
// the shared Modal and app-shell are the load-bearing mobile primitives. The Modal
// is a proper bottom-sheet on phones (dvh height, safe-area-bottom action row,
// focus trap + restore, ESC, body scroll-lock, aria-modal); the app-shell reserves
// space for the fixed mobile bottom tab bar and pads the safe areas. These guards
// ratchet those properties so a refactor can't quietly break mobile overlays.

const modal = fs.readFileSync('components/ui/modal.tsx', 'utf8');
const shell = fs.readFileSync('components/app/app-shell.tsx', 'utf8');

describe('shared Modal is a mobile-correct bottom sheet (Phase 11)', () => {
  it('sizes with dvh and never exceeds the visible viewport', () => {
    expect(modal).toMatch(/max-h-\[\d+dvh\]/);
    expect(modal).not.toMatch(/max-h-\[\d+vh\]/); // not static vh
  });
  it('keeps its bottom action row above the home indicator (safe-area inset)', () => {
    expect(modal).toContain('env(safe-area-inset-bottom)');
  });
  it('is a bottom sheet on phones, centered dialog on desktop', () => {
    expect(modal).toMatch(/items-end[\s\S]*sm:items-center/);
    expect(modal).toContain('rounded-t-3xl');
  });
  it('traps + restores focus, closes on ESC, and locks body scroll', () => {
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("e.key === 'Escape'");
    expect(modal).toContain("document.body.style.overflow = 'hidden'");
    expect(modal).toContain('previouslyFocused?.focus?.()');
  });
});

describe('app-shell reserves space for the mobile bottom nav + safe areas (Phase 8)', () => {
  it('main content clears the fixed bottom tab bar on mobile', () => {
    // pb-24 on mobile (bottom nav present), smaller on lg (no bottom nav).
    expect(shell).toMatch(/<main[^>]*pb-24[^>]*lg:pb-8/);
  });
  it('the mobile bottom nav clears the home indicator', () => {
    expect(shell).toMatch(/safe-bottom[\s\S]*fixed inset-x-0 bottom-0[\s\S]*lg:hidden/);
  });
});
