'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Dialogs nest: a delete confirmation opens on top of the dialog whose Delete
// button was pressed. Both listen for keys on `document`, so without a stack one
// Escape would dismiss both and the inner one's Tab trap would fight the outer
// one's. Only the top-most open dialog answers keys, and the scroll lock lifts
// only when the last one holding it closes.
const openDialogs: symbol[] = [];
const scrollLocks: symbol[] = [];
let overflowBeforeLock = '';

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
 *
 * PASS THE REAL CONDITION as `open`, not a literal `true`. The effect keys on
 * it, and bails when the ref is not attached yet. A component that returns
 * early while closed — `if (!enabled || unlocked) return <>{children}</>` —
 * would therefore run this once on mount, find no dialog, and NEVER RE-RUN,
 * so a dialog that opens after mount would silently have no trap at all.
 * `true` is only correct when the element is rendered on every pass (a modal
 * whose parent mounts it only while open).
 *
 * That is not hypothetical: the app-lock gate was adopted with `true` and had
 * exactly this hole until the condition was threaded through.
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

    const token = Symbol('dialog');
    openDialogs.push(token);

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === dialog);
    (focusables()[0] ?? dialog).focus();

    const onKey = (e: KeyboardEvent) => {
      // Only the top-most dialog answers keys: one Escape must not dismiss a
      // confirmation and the dialog underneath it at the same time.
      if (openDialogs[openDialogs.length - 1] !== token) return;
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
    if (lockScroll) {
      // Restore what was there rather than assuming '': a dialog opened from
      // inside another locked surface must not unlock the page behind both.
      if (scrollLocks.length === 0) overflowBeforeLock = document.body.style.overflow;
      scrollLocks.push(token);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      const at = openDialogs.lastIndexOf(token);
      if (at >= 0) openDialogs.splice(at, 1);
      document.removeEventListener('keydown', onKey);
      if (lockScroll) {
        const lockAt = scrollLocks.lastIndexOf(token);
        if (lockAt >= 0) scrollLocks.splice(lockAt, 1);
        // The lock lifts only when the last dialog holding it has closed.
        if (scrollLocks.length === 0) document.body.style.overflow = overflowBeforeLock;
      }
      previouslyFocused?.focus?.();
    };
  }, [ref, open, onClose, lockScroll]);
}
