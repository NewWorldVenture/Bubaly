'use client';

import { useEffect, useRef } from 'react';

/**
 * Escape closes an open popover — a dropdown menu, a picker, anything dismissed
 * by clicking away.
 *
 * This is the popover half of `useDialogBehavior`, and deliberately NOT that
 * hook. A dialog traps focus, locks body scroll and moves focus in and back
 * out; doing any of that to a dropdown would be wrong — the trigger button
 * should keep focus, and the page behind should keep scrolling.
 *
 * What this is for: six overlays across four modules — both `app-shell` menus,
 * the locator style and "more" menus, the chores row menu and the Guardian
 * trust picker — were dismissed by a click and by NOTHING ELSE. Every one of
 * them opens from a button a keyboard user can reach, so a keyboard user could
 * open a menu and then have no way to change their mind: no Escape, and the
 * click-away target is a transparent div a keyboard cannot land on. The only
 * exits were to activate an item or to tab out of the page.
 *
 * `onDismiss` is held in a ref and the effect depends on `open` ALONE, for the
 * reason `useDialogBehavior` gives at length: call sites pass an inline
 * `() => setOpen(false)`, a new identity on every render, which would tear the
 * listener down and rebuild it on every keystroke elsewhere in the component.
 */
export function useDismissOnEscape(open: boolean, onDismiss: () => void): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Do not swallow Escape from a dialog stacked above this popover: the
      // topmost layer should win, and a dialog's own handler runs on the same
      // document. Stopping propagation here would close the menu underneath
      // while leaving the dialog open.
      onDismissRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
}
