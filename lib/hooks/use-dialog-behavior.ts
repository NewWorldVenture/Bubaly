'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';

/**
 * Everything the WAI-ARIA dialog pattern asks of a modal surface, minus the
 * markup: focus moved in on open, Tab trapped inside, Escape closing, the
 * background scroll-locked, and focus returned to whatever opened it.
 *
 * Extracted from `components/ui/modal.tsx` so the hand-rolled full-screen
 * overlays that deliberately do NOT use `<Modal>` — the photo lightbox is
 * full-bleed black chrome, not a titled panel — get the same behaviour from the
 * same definition rather than a second copy that drifts.
 *
 * Attach the returned ref to the element carrying `role="dialog"`; it is the
 * boundary for both the focus trap and the "is focus still inside" test. The
 * caller owns the role, `aria-modal`, the labelling and the visual chrome.
 */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialogBehavior<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
): RefObject<T> {
  const dialogRef = useRef<T>(null);

  // `onClose` is held in a ref, and the effect below depends on `open` ALONE.
  //
  // It used to depend on `[open, onClose]`, and 92 of the 226 Modal call sites
  // pass an inline `onClose={() => setOpen(false)}` — a new function identity on
  // every render of the component that owns the dialog's form state. So every
  // keystroke in such a dialog tore the effect down and set it up again, and
  // both halves move focus: cleanup calls `previouslyFocused.focus()`, which by
  // then is the trigger BEHIND the dialog, and setup then focuses the first
  // control. Measured with the caret in the third field: focus went
  // trigger → field one, per character typed.
  //
  // Nothing about the trap needs to be rebuilt when the close handler's identity
  // changes; it only needs the CURRENT handler when Escape is actually pressed.
  // That is what a ref is for.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // One definition of the scroll lock, shared with the other full-screen
  // overlays. It captures and restores the PREVIOUS overflow rather than
  // clearing it outright, so a dialog opened on top of one of those gates
  // unwinds without unlocking the page underneath.
  useLockBodyScroll(open);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    // Remember what had focus so we can return to it on close (VoiceOver/TalkBack
    // + keyboard users land back where they were, per WAI-ARIA dialog practice).
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog (first focusable control, else the panel).
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((el) => el.offsetParent !== null || el === dialog);
    (focusables()[0] ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !dialog) return;
      // Trap Tab within the dialog.
      const items = focusables();
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
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  return dialogRef;
}
