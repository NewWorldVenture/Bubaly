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
 * NOT for an element that CONTAINS a button, link or input. `role="button"`
 * around nested interactive content is invalid ARIA and actively worse than the
 * warning it silences: the row is announced as a single button, and the pin,
 * duplicate and delete buttons inside it become confusing or unreachable. Those
 * rows need the primary action moved onto a child — the title as a real button
 * or link — which is a refactor per component, not a helper.
 *
 * That is the common case, not the rare one. Of the flagged elements left in
 * photos, notes, meals and locator, EVERY one either contains a nested button,
 * is a `stopPropagation` guard, or is a modal backdrop. `calendar-module` was
 * the exception. Spreading this everywhere would drop the warning count and
 * leave eighty invalid-ARIA rows behind, which is the kind of progress that is
 * really a regression.
 *
 * Also not for a click-outside scrim: it has nothing to activate, and giving it
 * a tab stop puts an invisible full-screen layer into the tab order. Those close
 * on Escape instead — and see
 * tests/a-row-you-can-click-is-a-row-you-can-reach.test.ts for why marking one
 * `aria-hidden` is a promise about the keyboard rather than a way out.
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

/**
 * A caption and the group of controls it names.
 *
 * The shape this is for is everywhere in this app: a `<label>` over a row of
 * toggle chips, trust levels, member pills or emoji buttons.
 *
 *     <label className="…">Trust levels</label>
 *     <div className="flex gap-1.5">{LEVELS.map(…<button/>…)}</div>
 *
 * That label names NOTHING. `<label>` names a form control, by `htmlFor` or by
 * containing it, and a group of buttons is neither — so a screen reader reads
 * "Trust levels" as a stray sentence and then reads seven unexplained buttons.
 * Fifty-two of these are on record (tests/a-group-of-controls-needs-a-name.test.ts).
 *
 * The fix needs no new copy, which is the point: the caption text already
 * exists and is already translated. It stops being a `<label>`, keeps its id,
 * and the container becomes a group that points at it.
 *
 *     const group = useId();
 *     <span id={group} className="…">Trust levels</span>
 *     <div {...labelledGroup(group)} className="flex gap-1.5">…</div>
 *
 * `role="group"` rather than `radiogroup`: these are multi-select toggles, and
 * claiming `radiogroup` would promise single-selection and arrow-key roving
 * that the buttons do not implement. A promise the markup does not keep is the
 * failure this audit keeps finding; `group` is the honest role.
 */
export function labelledGroup(labelId: string): { role: 'group'; 'aria-labelledby': string } {
  return { role: 'group', 'aria-labelledby': labelId };
}

/**
 * Make a clickable CARD reachable by keyboard, without stealing the keys its
 * own buttons need.
 *
 * The defect this exists for is not a lint warning, it is a dead end: a card
 * rendered as `<div onClick={open}>` has no `tabIndex`, so it is not in the tab
 * order at all. The pin/duplicate/delete buttons INSIDE it are focusable,
 * which makes the failure worse than it looks — a keyboard user can tab
 * straight into a note's destructive action while having no way at all to open
 * the note and read it.
 *
 * Why the card is not simply a `<button>`: it contains buttons, and nesting
 * interactive elements is invalid HTML with genuinely unpredictable results.
 * `role="button"` + `tabIndex={0}` + this handler is the documented fallback,
 * and it is what the lint rule itself asks for.
 *
 * The `e.target !== e.currentTarget` guard is the part that is easy to get
 * wrong, and omitting it introduces a NEW bug rather than fixing one: keydown
 * bubbles, so pressing Enter on the delete button inside the card would fire
 * the card's handler too and open the note as well as delete it.
 *
 * `preventDefault` on Space because Space scrolls the page by default, which is
 * the behaviour a real `<button>` suppresses and a div does not.
 */
export function openOnKey(
  e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void },
  open: () => void,
): void {
  if (e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  open();
}

/**
 * Run a card-action handler without letting the click reach the card behind it.
 *
 * This replaces the `<div onClick={(e) => e.stopPropagation()}>` wrapper that
 * used to sit around such buttons. That wrapper worked, but it made a plain
 * container look interactive — it carried a click handler while having no role,
 * no name and no keyboard path, which is exactly the shape the linter flags and
 * a reader has to stop and think about. Stopping propagation belongs on the
 * button that actually needs it.
 */
export function stopAnd<E extends { stopPropagation: () => void }>(run: () => void): (e: E) => void {
  return (e: E) => {
    e.stopPropagation();
    run();
  };
}
