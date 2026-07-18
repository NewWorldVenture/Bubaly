import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 11 — overlays & drawers) [M-012]: the shared
// `Modal` primitive locks background scroll while open (sets
// `document.body.style.overflow = 'hidden'`), but several hand-rolled full-screen
// overlays bypass `Modal`. On mobile Safari / Android Chrome an overlay that
// doesn't lock the body lets the page behind it keep scrolling ("scroll bleed") —
// the user can drag the underlying page out from under a camera viewfinder,
// command palette, paywall, or app-lock gate, and touch-scrolling the overlay
// bubbles to the body. These guards lock the shared `useLockBodyScroll` hook onto
// each blocking full-screen overlay and forbid a regression that drops it.

const HOOK = 'lib/hooks/use-lock-body-scroll.ts';

// Blocking full-screen overlays (fixed inset-0, cover the viewport) that must lock
// background scroll. Deliberately excludes the cookie-consent BANNER (a dismissible
// bottom bar that should NOT lock page scroll).
const overlays = {
  camera: 'components/ui/camera-capture.tsx',
  commandBar: 'components/app/command-bar.tsx',
  exitIntent: 'components/marketing/exit-intent.tsx',
  paywall: 'components/app/trial-paywall-gate.tsx',
  appLock: 'components/app/app-lock-gate.tsx',
  accountClosed: 'components/app/account-closed-gate.tsx',
};

describe('shared useLockBodyScroll hook', () => {
  it('exists and toggles body overflow based on an `active` flag', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    expect(src).toContain('export function useLockBodyScroll(active: boolean)');
    // Locks on activate and restores the captured previous value on cleanup.
    expect(src).toContain("body.style.overflow = 'hidden'");
    expect(src).toContain('body.style.overflow = previousOverflow');
    // Client-only guard so SSR/hydration is untouched.
    expect(src).toContain("typeof document === 'undefined'");
  });
});

describe('hand-rolled full-screen overlays lock background scroll on mobile', () => {
  for (const [name, file] of Object.entries(overlays)) {
    it(`${name} (${file}) uses useLockBodyScroll`, () => {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("from '@/lib/hooks/use-lock-body-scroll'");
      expect(src).toMatch(/useLockBodyScroll\(/);
    });
  }
});
