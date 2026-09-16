// lib/ui/a11y.ts — small, pure ARIA helpers so accessibility is consistent and
// testable rather than hand-rolled per component.

/**
 * ARIA props for a determinate progress bar. Spread onto the track element
 * (`<div {...progressBarA11y(pct, 'Savings goal')} …>`) so screen readers
 * announce it as a progress bar with the current percentage. Value is clamped
 * to [0,100] and rounded, so callers can pass a raw ratio-derived number.
 */
export function progressBarA11y(value: number, label: string): {
  role: 'progressbar';
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-label': string;
} {
  const now = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return {
    role: 'progressbar',
    'aria-valuenow': now,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-label': label,
  };
}

/**
 * Props that make a non-button element behave like one for the keyboard.
 *
 * The app renders a lot of rows that are clickable `<div>`s — a calendar event,
 * a photo tile, a note card. They respond to a mouse and to nothing else, so a
 * keyboard or switch user cannot reach them at all: no tab stop, no Enter, no
 * Space. `jsx-a11y/click-events-have-key-events` and
 * `no-static-element-interactions` name 94 of them across 34 files.
 *
 * A real `<button>` is the better answer where the markup allows it. Where it
 * does not — an absolutely-positioned block in a day grid, a row whose layout
 * would have to be rebuilt around a button's defaults — this is the alternative
 * the rule itself names: "add an appropriate role and support for tabbing,
 * mouse, keyboard, and touch inputs". One definition rather than 94 hand-rolled
 * copies, because the hand-rolled copies are how the ILIKE escape came to reach
 * four call sites with two of them still wrong.
 *
 * Only for elements that genuinely ACTIVATE something. A click-outside scrim is
 * not one: it has nothing to activate, and giving it a tab stop puts an
 * invisible full-screen layer into the tab order. Those close on Escape
 * instead.
 *
 *     <div {...activatable(() => setSelected(event))} className="…">
 */
export function activatable(onActivate: () => void): {
  role: 'button';
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // A control that answers a key must also consume it: Space scrolls the
      // page on anything that is not a real button, and Enter submits an
      // enclosing form. Handling the key and letting the default run as well is
      // how "it works" becomes "it works and the page jumps".
      event.preventDefault();
      onActivate();
    },
  };
}
