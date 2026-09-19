'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * What `aria-modal="true"` actually promises, as a hook.
 *
 * The attribute tells assistive technology that everything outside this element
 * is inert. Declaring it without making it true is worse than a plain `<div>`:
 * a screen-reader user is told to ignore a background their keyboard can still
 * reach, and they have no way to discover otherwise.
 *
 * `components/ui/modal.tsx` implements all of this, and eleven other components
 * declared `aria-modal` while implementing none of it. The reason is structural
 * rather than careless: Modal couples the BEHAVIOUR here to its own CHROME —
 * backdrop, title bar, close button, bottom-sheet layout — so a camera
 * viewfinder, a command palette and a full-screen paywall gate could not take
 * the chrome, and therefore took neither.
 *
 * This is the behaviour on its own, so an overlay with its own layout can keep
 * the layout and still keep the promise:
 *
 *   - focus moves into the dialog on open (first focusable, else the panel);
 *   - Tab and Shift+Tab cycle WITHIN it and cannot escape;
 *   - Escape closes, when the caller supplies `onClose`;
 *   - the background is scroll-locked;
 *   - focus returns to whatever had it, on close.
 *
 * A gate that must not be dismissed (a paywall, a lock screen) passes no
 * `onClose` and keeps the trap without an exit, which is the correct shape for
 * it: `aria-modal` still has to be true even when there is nothing to close.
 */
export function useDialogBehavior(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  options: { onClose?: () => void; lockScroll?: boolean } = {},
): void {
  const { onClose, lockScroll = true } = options;

  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === dialog);
    (focusables()[0] ?? dialog).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // No `onClose` means this dialog is not dismissible. Escape does
        // nothing, and the trap below still holds — which is the point.
        if (onClose) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      // Nothing focusable inside: keep focus on the panel rather than letting
      // Tab walk out into the background this element claims is inert.
      if (items.length === 0) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore what was there rather than assuming '': a dialog opened from
      // inside another locked surface must not unlock the page behind both.
      if (lockScroll) document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [ref, open, onClose, lockScroll]);
}
