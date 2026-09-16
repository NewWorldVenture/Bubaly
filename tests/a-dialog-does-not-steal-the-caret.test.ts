import { describe, expect, it, vi } from 'vitest';

// Typing in a dialog moved the caret to the first field, on every character.
//
// `Modal`'s focus-trap effect depended on `[open, onClose]`, and 92 of the 226
// call sites pass an inline `onClose={() => setOpen(false)}` — a new function
// identity on every render of the component that owns the dialog's form state.
// So a keystroke re-rendered that component, the deps compared unequal, and
// React tore the effect down and set it up again. BOTH halves move focus:
//
//   cleanup:  previouslyFocused?.focus()   → the trigger BEHIND the dialog
//   setup:    focusables()[0]?.focus()     → the first control in the dialog
//
// 71 call sites pair an inline `onClose` with a controlled input, which is the
// combination that bites: announcements, behavior, binder, care, celebrations,
// devices, quick-capture and the rest. Anything but the first field was
// untypeable.
//
// This drives the real component's real effect the way React drives it —
// render, run, re-render with a fresh arrow, cleanup, run — and watches every
// `.focus()` call. It is a harness, not a browser: it models React's
// cleanup-then-setup ordering and the DOM calls the effect makes, and nothing
// else.
type Slot = { current: unknown };
const mocks = vi.hoisted(() => ({
  slots: [] as Slot[],
  cursor: 0,
  effects: [] as { run: () => undefined | (() => void); deps: readonly unknown[] }[],
  focused: [] as string[],
}));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: (init: unknown) => {
    const i = mocks.cursor++;
    if (!(i in mocks.slots)) mocks.slots[i] = { current: init };
    return mocks.slots[i];
  },
  useId: () => 'id',
  useContext: () => ({ locale: { code: 'en-US' }, source: 'default', t: (k: string) => k }),
  useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    mocks.effects.push({ run: fn as () => undefined | (() => void), deps: deps ?? [] });
  },
}));
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));

const { Modal } = await import('@/components/ui/modal');

type El = { focus: () => void; offsetParent: unknown };
const named: Record<string, El> = {};
for (const name of ['trigger', 'field1', 'field2', 'field3']) {
  named[name] = {
    offsetParent: {},
    focus: () => {
      mocks.focused.push(name);
      (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = named[name];
    },
  };
}

function mountOpenDialog() {
  mocks.slots.length = 0;
  mocks.cursor = 0;
  mocks.effects.length = 0;
  mocks.focused.length = 0;
  (globalThis as Record<string, unknown>).document = {
    activeElement: named.trigger,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {} as Record<string, string> },
  };

  const render = (onClose: () => void) => {
    mocks.cursor = 0;
    mocks.effects.length = 0;
    (Modal as unknown as (p: Record<string, unknown>) => unknown)({
      open: true, onClose, title: 't', children: null,
    });
    // dialogRef is the first useRef; give it a panel with three fields.
    (mocks.slots[0] as Slot).current = {
      querySelectorAll: () => [named.field1, named.field2, named.field3],
      focus: () => mocks.focused.push('panel'),
      contains: () => true,
    };
    return mocks.effects[0];
  };
  return render;
}

describe('a dialog does not steal the caret while you type in it', () => {
  it('does not rebuild the focus trap when only the close handler identity changes', () => {
    const render = mountOpenDialog();

    const first = render(() => {});
    const cleanup = first.run();
    expect(mocks.focused, 'opening should focus the first control').toEqual(['field1']);

    // The user clicks into the third field and types one character. That
    // re-renders the component holding the form state, so the inline arrow is
    // a brand-new function.
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = named.field3;
    mocks.focused.length = 0;
    const second = render(() => {});

    expect(second.deps, 'the effect must not depend on the handler identity').toEqual(first.deps);

    // React only re-runs when the deps compare unequal. They do not, so nothing
    // below should happen — but run it the way React would if they had, so the
    // assertion is about the deps AND about what a re-run would cost.
    const depsChanged = first.deps.some((d, i) => !Object.is(d, second.deps[i]))
      || first.deps.length !== second.deps.length;
    expect(depsChanged).toBe(false);
    expect(mocks.focused, 'nothing should have moved focus').toEqual([]);

    // And the trap still works: closing restores focus to the trigger.
    cleanup?.();
    expect(mocks.focused).toEqual(['trigger']);
  });

  it('still closes on Escape using the CURRENT handler, not the one it opened with', () => {
    const render = mountOpenDialog();
    const listeners: ((e: { key: string }) => void)[] = [];
    (globalThis as Record<string, unknown>).document = {
      activeElement: named.trigger,
      addEventListener: (_: string, fn: (e: { key: string }) => void) => listeners.push(fn),
      removeEventListener: () => {},
      body: { style: {} as Record<string, string> },
    };

    const stale = vi.fn();
    const effect = render(stale);
    effect.run();

    // A later render swaps in a different handler. The effect does NOT re-run,
    // so a handler captured in the closure would be the stale one — which is
    // exactly the bug a ref avoids.
    const current = vi.fn();
    render(current);

    listeners.forEach((fn) => fn({ key: 'Escape' }));
    expect(current, 'Escape used a stale handler').toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
