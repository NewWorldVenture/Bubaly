'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Dialogs nest: a delete confirmation opens on top of the dialog whose Delete
// button was pressed. Both listen for keys on `document`, so without a stack one
// Escape would dismiss both and the inner one's Tab trap would fight the outer
// one's. Only the top-most open dialog answers keys, and the scroll lock lifts
// only when the last one holding it closes.
const openDialogs: symbol[] = [];
const scrollLocks: symbol[] = [];
let overflowBeforeLock = '';

// Where focus was before it entered a dialog (MAIN-F-D04). A field inside the
// dialog with `autoFocus` takes focus while React commits the dialog, BEFORE the
// effect below runs, so `document.activeElement` there is already inside the
// dialog. The effect saved that field as "previously focused"; the field was
// removed on close, and focus fell to <body> (Quick capture and the wallet's
// dialogs, reproduced 2026-09-30). Recording focus as it moves still holds the
// trigger when the effect runs.
const FOCUS_HISTORY = 8;
const focusHistory: HTMLElement[] = [];
let trackingFocus = false;
function trackFocus(): void {
  if (trackingFocus || typeof document === 'undefined') return;
  trackingFocus = true;
  document.addEventListener('focusin', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.focus !== 'function') return;
    const at = focusHistory.indexOf(target);
    if (at >= 0) focusHistory.splice(at, 1);
    focusHistory.push(target);
    if (focusHistory.length > FOCUS_HISTORY) focusHistory.shift();
  }, true);
}
// Installed when the module loads, so the trigger's focus is seen before any
// dialog opens.
trackFocus();

/** The most recent focus outside `dialog`, from before focus entered it. */
function openerFromHistory(dialog: HTMLElement): HTMLElement | null {
  for (let i = focusHistory.length - 1; i >= 0; i -= 1) {
    const candidate = focusHistory[i];
    if (candidate.isConnected && !dialog.contains(candidate)) return candidate;
  }
  return null;
}

/**
 * The opener went with the content that held it (a deleted row): land on the
 * page's main landmark, the skip link's target, rather than on <body>.
 */
function focusMainLandmark(): void {
  const main = (document.getElementById?.('main-content') ?? document.querySelector?.('main')) as HTMLElement | null;
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
}

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
 *   - focus returns to whatever had it before the dialog opened (even when a
 *     field inside took focus with `autoFocus`), or to the main landmark if
 *     that element is gone.
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

  // `onClose` is held in a REF and the effect below does not depend on it.
  //
  // 92 of the 226 call sites pass an inline `onClose={() => setOpen(false)}` — a
  // fresh function identity on every render of the component that owns the
  // dialog's form state. With `onClose` in the dependency array, a single
  // keystroke re-rendered that component, the deps compared unequal, and React
  // tore the effect down and set it up again. Both halves move focus: cleanup
  // restores the trigger BEHIND the dialog, setup focuses the FIRST control in
  // it. Anything but the first field was untypeable.
  //
  // The ref keeps Escape calling the CURRENT handler while the trap itself is
  // built once per open. Pinned by tests/a-dialog-does-not-steal-the-caret.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    if (!dialog) return;

    const token = Symbol('dialog');
    openDialogs.push(token);

    let previouslyFocused = document.activeElement as HTMLElement | null;
    // `autoFocus` inside the dialog already moved focus: the opener is in the
    // focus history, not in `document.activeElement`.
    if (!previouslyFocused || previouslyFocused === document.body || dialog.contains(previouslyFocused)) {
      previouslyFocused = openerFromHistory(dialog) ?? previouslyFocused;
    }

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
        onCloseRef.current?.();
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
      if (previouslyFocused && previouslyFocused !== document.body && previouslyFocused.isConnected !== false
        && !previouslyFocused.closest?.('[inert]')) previouslyFocused?.focus?.();
      if (document.activeElement !== previouslyFocused || previouslyFocused === document.body) focusMainLandmark();
    };
  }, [ref, open, lockScroll]);
}
