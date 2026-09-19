import { describe, expect, it, vi } from 'vitest';
import { openOnKey, stopAnd } from '@/lib/ui/a11y';

/**
 * A note card rendered as `<div onClick={open}>` is not in the tab order at
 * all, so it cannot be opened from a keyboard. What makes that worse than it
 * sounds is that the pin/duplicate/DELETE buttons inside it ARE focusable: a
 * keyboard user could tab straight into a note's destructive action while
 * having no way to open the note and read it first.
 *
 * These helpers are the fallback the lint rule asks for when the element cannot
 * be a real `<button>` — and here it cannot, because it contains buttons and
 * nesting interactive elements is invalid.
 */

type Key = { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void };
const CARD = Symbol('card');
const INNER = Symbol('a button inside the card');

const press = (key: string, target: unknown = CARD): Key & { prevented: boolean } => {
  const e = {
    key, target, currentTarget: CARD, prevented: false,
    preventDefault() { e.prevented = true; },
  };
  return e as Key & { prevented: boolean };
};

describe('openOnKey', () => {
  it('opens on Enter and on Space', () => {
    for (const key of ['Enter', ' ']) {
      const open = vi.fn();
      openOnKey(press(key), open);
      expect(open, key).toHaveBeenCalledOnce();
    }
  });

  it('suppresses the page scroll that Space would otherwise cause', () => {
    // A real <button> swallows Space; a div does not, so without this the page
    // jumps a screen every time someone opens a note.
    const e = press(' ');
    openOnKey(e, () => {});
    expect(e.prevented).toBe(true);
  });

  it('ignores keys that are not activation keys', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', 'Shift']) {
      const open = vi.fn();
      openOnKey(press(key), open);
      expect(open, key).not.toHaveBeenCalled();
    }
  });

  /**
   * The guard that matters, and the reason this file exists.
   *
   * keydown BUBBLES. Without `e.target !== e.currentTarget`, pressing Enter on
   * the delete button inside the card would fire the button AND the card's
   * handler — deleting the note and opening it in the same keystroke. Removing
   * that line does not merely fail to fix a bug, it introduces one.
   */
  it('does not fire when the key was pressed on something inside the card', () => {
    const open = vi.fn();
    openOnKey(press('Enter', INNER), open);
    expect(open).not.toHaveBeenCalled();
    // ...and it must not swallow the key either: the inner button needs it.
    const e = press('Enter', INNER);
    openOnKey(e, () => {});
    expect(e.prevented).toBe(false);
  });
});

describe('stopAnd', () => {
  it('runs the action and stops the click reaching the card behind it', () => {
    const run = vi.fn();
    const stopPropagation = vi.fn();
    stopAnd(run)({ stopPropagation });
    expect(run).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('stops propagation even when the action itself declines to act', () => {
    // The delete button is `stopAnd(() => { if (confirm(...)) onDelete(); })`.
    // Cancelling the confirm must still not open the note.
    const stopPropagation = vi.fn();
    stopAnd(() => {})({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
