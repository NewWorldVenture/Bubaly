import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localeContextValue } from './helpers/render-translated';

// A toast that carries "Undo" is a time limit on the only way back.
//
// WCAG 2.2.1 (Timing Adjustable) asks that a time limit on content be pausable,
// extendable, or turn-off-able. This one had none of the three: `setTimeout`
// was called for its side effect and the id thrown away, so nothing in the
// component could reach the pending dismissal, and the container had no hover
// or focus handlers to reach it from.
//
// For an ordinary confirmation that is a nuisance. For the three toasts that
// carry "Undo" it is the whole safety net: quick capture, the ⌘K bar and voice
// capture each call `undoCapture` from a toast action and from nowhere else, so
// when the toast goes, the row it wrote stays. And the stack renders AFTER
// {children}, so a keyboard user reaching that button tabs past the entire rest
// of the page first — inside seven seconds.
//
// (components/capture/capture-shell.tsx is the exception that shows the rule:
// its undo is a durable in-page button, so nothing there is on a clock.)
//
// This runs the real component's real timer lifecycle. It is not a source scan:
// every assertion below is the consequence of a `setTimeout` that did or did
// not fire.

type Slot = unknown;
const mocks = vi.hoisted(() => ({ slots: [] as Slot[], cursor: 0 }));

// The component is invoked as a plain function — there is no React dispatcher —
// so the four hooks it uses are supplied here. Only useState and useRef consume
// a slot; useCallback and useMemo hand back the thing they were given, which is
// exactly what React guarantees they may do at any time.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => {
      // The updater runs even when it returns the value it was handed:
      // `resumeAll` re-arms every timer from inside one and returns `current`
      // unchanged, and dropping that call would silently delete the resume.
      slots[index] = typeof value === 'function' ? value(slots[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  // `useTranslations()` reads a context; hand it the real English catalogue.
  useContext: () => localeContextValue(),
}));

const { ToastProvider, LIFETIME } = await import('@/components/ui/toast');

type Props = Record<string, unknown> & { children?: ReactNode };
const propsOf = (el: ReactElement): Props => el.props as Props;

function find(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  return find(propsOf(node).children ?? null, match);
}

function findAll(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) { for (const c of n) walk(c as ReactNode); return; }
    if (!isValidElement(n)) return;
    if (match(n)) out.push(n);
    walk(propsOf(n).children ?? null);
  };
  walk(node);
  return out;
}

/** Every string a person would read out of this subtree. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((c) => textOf(c as ReactNode)).join('');
  if (isValidElement(node)) return textOf(propsOf(node).children ?? null);
  return '';
}

type Api = {
  toast: (message: string, tone?: 'success' | 'error' | 'info', action?: { label: string; onClick: () => void }) => void;
  success: (message: string, action?: { label: string; onClick: () => void }) => void;
  error: (message: string, action?: { label: string; onClick: () => void }) => void;
};

/** One render pass. Returns what the user can see and what they can reach. */
function render() {
  mocks.cursor = 0;
  const root = (ToastProvider as unknown as (p: { children: ReactNode }) => ReactElement)({ children: null });
  const api = propsOf(root).value as Api;
  const stack = find(root, (el) => typeof propsOf(el).onMouseEnter === 'function');
  expect(stack, 'the toast stack has no hover handler — nothing can pause it').not.toBeNull();
  const toasts = findAll(root, (el) => {
    const role = propsOf(el).role;
    return role === 'status' || role === 'alert';
  });
  return {
    api,
    toasts: toasts.map(textOf),
    hover: propsOf(stack!).onMouseEnter as () => void,
    unhover: propsOf(stack!).onMouseLeave as () => void,
    focus: propsOf(stack!).onFocusCapture as () => void,
    blur: propsOf(stack!).onBlurCapture as () => void,
    click: (label: string) => {
      const button = find(root, (el) => el.type === 'button' && textOf(el) === label);
      expect(button, `no button reading "${label}"`).not.toBeNull();
      (propsOf(button!).onClick as () => void)();
    },
    dismissButton: () => find(root, (el) => propsOf(el)['aria-label'] === 'Dismiss'),
  };
}

beforeEach(() => {
  mocks.slots.length = 0;
  mocks.cursor = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const AN_AGE = 10 * 60 * 1000;

describe('a toast keeps its own clock', () => {
  it('dismisses itself when its window runs out', () => {
    // The baseline every pause assertion below depends on. If this stopped
    // being true — if the timer never fired at all — "it survived" would prove
    // nothing.
    render().api.success('Saved');
    vi.advanceTimersByTime(LIFETIME.plain - 1);
    expect(render().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(render().toasts).toEqual([]);
  });

  it('gives a toast you can act on longer than one you only read', () => {
    expect(LIFETIME.action).toBeGreaterThan(LIFETIME.plain);
  });
});

describe('a time limit you can pause', () => {
  it('holds every toast open while the stack is hovered', () => {
    const first = render();
    first.api.success('Note added', { label: 'Undo', onClick: () => {} });
    // Nearly out of time, which is exactly when someone reaches for it.
    vi.advanceTimersByTime(LIFETIME.action - 500);
    render().hover();
    vi.advanceTimersByTime(AN_AGE);
    expect(render().toasts.join('')).toContain('Undo');
  });

  it('holds every toast open while focus is anywhere inside the stack', () => {
    // The half that matters for the keyboard user this is for: the stack sits
    // after {children}, so they tab the whole page to get here, and the
    // countdown has to stop the moment focus lands — not when a pointer moves.
    render().api.success('Note added', { label: 'Undo', onClick: () => {} });
    vi.advanceTimersByTime(LIFETIME.action - 500);
    render().focus();
    vi.advanceTimersByTime(AN_AGE);
    expect(render().toasts.join('')).toContain('Undo');
  });

  it('hands back a whole window on release, not the sliver that was left', () => {
    render().api.success('Saved');
    vi.advanceTimersByTime(LIFETIME.plain - 100);
    const paused = render();
    paused.hover();
    paused.unhover();
    // 100ms was all that remained. Someone who stopped to read needs time to
    // act, so the window restarts.
    vi.advanceTimersByTime(LIFETIME.plain - 100);
    expect(render().toasts).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(render().toasts).toEqual([]);
  });

  it('resumes the clock when focus leaves, so a paused toast is not permanent', () => {
    render().api.success('Saved');
    const focused = render();
    focused.focus();
    vi.advanceTimersByTime(AN_AGE);
    expect(render().toasts).toHaveLength(1);
    focused.blur();
    vi.advanceTimersByTime(LIFETIME.plain);
    expect(render().toasts).toEqual([]);
  });
});

describe('closing a toast takes its timer with it', () => {
  it('leaves nothing pending when the action is taken', () => {
    let undone = 0;
    render().api.success('Note added', { label: 'Undo', onClick: () => { undone += 1; } });
    render().click('Undo');
    expect(undone).toBe(1);
    expect(render().toasts).toEqual([]);
    // A timer left running here is a dismissal aimed at an id that no longer
    // exists — harmless today, and a bug the moment ids are reused.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing pending when it is dismissed by hand', () => {
    render().api.error('Could not save');
    const shown = render();
    expect(shown.dismissButton(), 'the toast has no dismiss button').not.toBeNull();
    (propsOf(shown.dismissButton()!).onClick as () => void)();
    expect(render().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
