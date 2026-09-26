import type { KeyboardEvent } from 'react';

/**
 * Enter and Space activate an element that is not a native button, the way
 * they activate one. Pair it with `role="button"` and `tabIndex={0}` on an
 * element that already has an `onClick`, so a keyboard user can reach and use
 * what a mouse user can (MAIN-F-D06: calendar events, goal cards and file
 * drop zones answered only a click).
 *
 * A key pressed on something INSIDE the element belongs to that thing, so only
 * keys aimed at the element itself count. Space is prevented from scrolling the
 * page, as it is on a native button.
 */
export function activateOnKey(activate: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
}
