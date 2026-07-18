'use client';

import { useEffect } from 'react';

/**
 * Locks background (body) scroll while `active` is true, restoring the previous
 * overflow on cleanup.
 *
 * On mobile Safari / Android Chrome a full-screen overlay that doesn't lock the
 * body lets the page behind it keep scrolling ("scroll bleed") — the user can
 * drag the underlying page out from under a camera viewfinder, command palette,
 * paywall, or app-lock gate, and touch-scrolling the overlay bubbles to the body.
 * The shared `Modal` primitive already does this inline; this hook gives the
 * hand-rolled full-screen overlays that bypass `Modal` the same guarantee.
 *
 * Client-only (runs in an effect), so it never affects SSR/hydration. Captures
 * the prior `overflow` value at lock time and restores exactly that, so stacked
 * overlays unwind correctly.
 */
export function useLockBodyScroll(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [active]);
}
