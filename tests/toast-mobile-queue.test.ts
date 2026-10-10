import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localeContextValue } from './helpers/render-translated';

// Below lg the toasts form a queue (A11Y-001, approved on #778): one notice
// on screen at a time — the newest not yet dismissed — older ones waiting in
// arrival order with NO clock running, each given a full window when it
// shows; "+N" opens the whole stack so every Dismiss and Undo stays reachable;
// each message is announced once, when it is pushed. From lg nothing changes
// (tests/a-toast-you-can-still-reach-waits.test.ts holds the desktop stack).
//
// Same harness as that file: the real component, its real timers, the hooks
// supplied here. Effects run on every render pass, as the reconcile they hold
// is idempotent; `queue` is what useMediaQuery('(max-width: 1023px)') answers.

type Slot = unknown;
const mocks = vi.hoisted(() => ({ slots: [] as Slot[], cursor: 0, queue: true, plural: (() => '') as (key: string, count: number) => string }));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    const slots = mocks.slots;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: unknown) => {
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
  useEffect: (effect: () => void) => { effect(); },
  // The real English catalogue, with the provider's plural() over it.
  useContext: () => ({ ...localeContextValue(), plural: mocks.plural }),
}));
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => mocks.queue }));

const { getMessages } = await import('@/lib/i18n/messages');
const { pluralize } = await import('@/lib/i18n/translate');
mocks.plural = (key, count) => pluralize(getMessages('en-US'), 'en-US', key, count);
const { ToastProvider, LIFETIME, QUEUE_QUERY } = await import('@/components/ui/toast');

type Props = Record<string, unknown> & { children?: ReactNode };
const propsOf = (el: ReactElement): Props => el.props as Props;
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
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((c) => textOf(c as ReactNode)).join('');
  if (isValidElement(node)) return textOf(propsOf(node).children ?? null);
  return '';
}

type Action = { label: string; onClick: () => void };
type Api = { toast: (m: string, tone?: 'success' | 'error' | 'info', a?: Action) => void; success: (m: string, a?: Action) => void; error: (m: string, a?: Action) => void };

function render() {
  mocks.cursor = 0;
  const root = (ToastProvider as unknown as (p: { children: ReactNode }) => ReactElement)({ children: null });
  const stack = findAll(root, (el) => typeof propsOf(el).onMouseEnter === 'function')[0];
  // A notice card: the element keyed by its toast id inside the stack. Queued
  // cards are in the tree, visually hidden (sr-only); `shown` is the rest.
  const all = findAll(propsOf(stack).children ?? null, (el) => el.type === 'div' && el.key !== null);
  const cards = all.filter((c) => !String(propsOf(c).className).split(' ').includes('sr-only'));
  const more = findAll(stack, (el) => propsOf(el)['aria-expanded'] !== undefined)[0] ?? null;
  const live = findAll(root, (el) => propsOf(el).role === 'status' || propsOf(el).role === 'alert');
  return {
    api: propsOf(root).value as Api,
    /** The notices on screen, top to bottom. */
    shown: cards.map((c) => textOf(findAll(c, (el) => propsOf(el).className === 'flex-1')[0])),
    cardRoles: cards.map((c) => propsOf(c).role),
    /** Every notice in the tree, queued ones included: text, live role, whether its buttons are in the tab order. */
    tree: all.map((c) => ({
      text: textOf(findAll(c, (el) => propsOf(el).className === 'flex-1')[0]),
      role: propsOf(c).role,
      queued: propsOf(c)['data-queued'] === true,
      tabbable: findAll(c, (b) => b.type === 'button').every((b) => propsOf(b).tabIndex !== -1),
    })),
    more,
    live: live.map((el) => ({ role: propsOf(el).role, politeness: propsOf(el)['aria-live'], text: textOf(findAll(el, (x) => propsOf(x).className === 'flex-1')[0]) })),
    hover: () => (propsOf(stack).onMouseEnter as () => void)(),
    unhover: () => (propsOf(stack).onMouseLeave as () => void)(),
    focus: () => (propsOf(stack).onFocusCapture as () => void)(),
    blur: () => (propsOf(stack).onBlurCapture as () => void)(),
    dismiss: (message: string) => {
      const card = cards.find((c) => textOf(c).includes(message));
      expect(card, `no card for "${message}" on screen`).toBeTruthy();
      (propsOf(findAll(card!, (b) => propsOf(b)['aria-label'] === 'Dismiss')[0]).onClick as () => void)();
    },
    act: (message: string, label: string) => {
      const card = cards.find((c) => textOf(c).includes(message));
      expect(card, `no card for "${message}" on screen`).toBeTruthy();
      const button = findAll(card!, (b) => b.type === 'button' && textOf(b) === label)[0];
      (propsOf(button).onClick as () => void)();
    },
  };
}

beforeEach(() => {
  mocks.slots.length = 0;
  mocks.cursor = 0;
  mocks.queue = true;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const AN_AGE = 10 * 60 * 1000;

it('is the mode below lg, and only there', () => {
  expect(QUEUE_QUERY).toBe('(max-width: 1023px)');
});

describe('one notice on screen, the newest; the rest wait without a clock', () => {
  it('shows the newest of three, with "+2", and only it counts down', () => {
    const { api } = render();
    api.success('One');
    api.success('Two');
    api.success('Three');
    const view = render();
    expect(view.shown).toEqual(['Three']);
    expect(propsOf(view.more!)['aria-label']).toBe('2 more notices');
    expect(propsOf(view.more!)['aria-expanded']).toBe(false);
    expect(textOf(view.more!)).toBe('+2');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('when the one on screen expires, the next-newest shows with a whole window', () => {
    const { api } = render();
    api.success('One');
    api.success('Two');
    render();
    vi.advanceTimersByTime(LIFETIME.plain);
    expect(render().shown).toEqual(['One']);
    vi.advanceTimersByTime(LIFETIME.plain - 1);
    expect(render().shown).toEqual(['One']);
    vi.advanceTimersByTime(1);
    expect(render().shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains in order, newest first, each shown in turn, nothing dropped', () => {
    const { api } = render();
    for (const m of ['One', 'Two', 'Three']) api.success(m);
    const seen: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      seen.push(...render().shown);
      vi.advanceTimersByTime(LIFETIME.plain);
    }
    expect(seen).toEqual(['Three', 'Two', 'One']);
    expect(render().shown).toEqual([]);
  });

  it('a queued Undo outlives its own 7 s while it waits, and keeps it once shown', () => {
    const first = vi.fn();
    const { api } = render();
    api.success('Note added', { label: 'Undo', onClick: first });
    api.success('Task added', { label: 'Undo', onClick: () => {} });
    render();
    vi.advanceTimersByTime(LIFETIME.action - 100);
    expect(render().shown).toEqual(['Task added']);
    vi.advanceTimersByTime(100);
    expect(render().shown).toEqual(['Note added']);
    vi.advanceTimersByTime(LIFETIME.action - 100);
    const view = render();
    expect(view.shown).toEqual(['Note added']);
    view.act('Note added', 'Undo');
    expect(first).toHaveBeenCalledTimes(1);
    expect(render().shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dismissing the one on screen shows the next, and removes nothing else', () => {
    const { api } = render();
    api.error('First refused');
    api.error('Second refused');
    render().dismiss('Second refused');
    expect(render().shown).toEqual(['First refused']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a new notice, urgent or not, shows at once; the one it displaces waits', () => {
    const { api } = render();
    api.success('Saved');
    vi.advanceTimersByTime(LIFETIME.plain - 200);
    api.error('Could not send');
    expect(render().shown).toEqual(['Could not send']);
    vi.advanceTimersByTime(AN_AGE / 100);
    expect(render().shown).toEqual(['Saved']);
  });
});

describe('held by hover or focus', () => {
  it('a notice pushed while held does not count down until released', () => {
    const view = render();
    view.hover();
    view.api.success('Saved');
    vi.advanceTimersByTime(AN_AGE);
    expect(render().shown).toEqual(['Saved']);
    render().unhover();
    vi.advanceTimersByTime(LIFETIME.plain - 1);
    expect(render().shown).toEqual(['Saved']);
    vi.advanceTimersByTime(1);
    expect(render().shown).toEqual([]);
  });

  it('focus holds it too, and blur resumes only the one on screen', () => {
    const { api } = render();
    api.success('One');
    api.success('Two');
    const view = render();
    view.focus();
    vi.advanceTimersByTime(AN_AGE);
    expect(render().shown).toEqual(['Two']);
    render().blur();
    render();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('"+N" opens every notice, so each Dismiss and Undo can be reached', () => {
  it('expands to all, in arrival order, with no clock running; leaving closes it', () => {
    const { api } = render();
    for (const m of ['One', 'Two', 'Three']) api.success(m, { label: 'Undo', onClick: () => {} });
    (propsOf(render().more!).onClick as () => void)();
    const open = render();
    expect(open.shown).toEqual(['One', 'Two', 'Three']);
    expect(propsOf(open.more!)['aria-expanded']).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(AN_AGE);
    expect(render().shown).toHaveLength(3);
    render().unhover();
    const closed = render();
    expect(closed.shown).toEqual(['Three']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('an older notice can be acted on from the open list', () => {
    const undo = vi.fn();
    const { api } = render();
    api.success('Note added', { label: 'Undo', onClick: undo });
    api.success('Saved');
    (propsOf(render().more!).onClick as () => void)();
    render().act('Note added', 'Undo');
    expect(undo).toHaveBeenCalledTimes(1);
    const after = render();
    expect(after.shown).toEqual(['Saved']);
    expect(after.more).toBeNull();
  });

  it('Escape closes the list', () => {
    const { api } = render();
    api.success('One');
    api.success('Two');
    (propsOf(render().more!).onClick as () => void)();
    mocks.cursor = 0;
    const root = (ToastProvider as unknown as (p: { children: ReactNode }) => ReactElement)({ children: null });
    const stack = findAll(root, (el) => typeof propsOf(el).onKeyDown === 'function')[0];
    (propsOf(stack).onKeyDown as (e: { key: string }) => void)({ key: 'Escape' });
    expect(render().shown).toEqual(['Two']);
  });
});

describe('announced once, when pushed', () => {
  it('every notice is its own live region from the moment it arrives, queued ones included, each once', () => {
    const { api } = render();
    api.success('Saved');
    api.error('Could not send');
    api.success('Added');
    const view = render();
    // One live element per notice, in arrival order, each with its tone's
    // politeness: what a screen reader is handed on push.
    expect(view.live).toEqual([
      { role: 'status', politeness: 'polite', text: 'Saved' },
      { role: 'alert', politeness: 'assertive', text: 'Could not send' },
      { role: 'status', politeness: 'polite', text: 'Added' },
    ]);
    // Queued ones are visually hidden but in the tree with their actions, out
    // of the tab order ("+N" is the way back in for a keyboard).
    expect(view.tree).toEqual([
      { text: 'Saved', role: 'status', queued: true, tabbable: false },
      { text: 'Could not send', role: 'alert', queued: true, tabbable: false },
      { text: 'Added', role: 'status', queued: false, tabbable: true },
    ]);
    expect(view.shown).toEqual(['Added']);
  });

  it('a queued notice coming on screen is the same element, so nothing is announced again', () => {
    const { api } = render();
    api.success('One');
    api.success('Two');
    expect(render().live.map((l) => l.text)).toEqual(['One', 'Two']);
    render().dismiss('Two');
    const after = render();
    expect(after.live.map((l) => l.text)).toEqual(['One']);
    expect(after.tree).toEqual([{ text: 'One', role: 'status', queued: false, tabbable: true }]);
  });
});

describe('crossing lg', () => {
  it('back on a desktop every notice shows and counts; on a phone again only the newest', () => {
    const { api } = render();
    for (const m of ['One', 'Two', 'Three']) api.success(m);
    render();
    expect(vi.getTimerCount()).toBe(1);
    mocks.queue = false;
    const desk = render();
    expect(desk.shown).toEqual(['One', 'Two', 'Three']);
    expect(desk.cardRoles).toEqual(['status', 'status', 'status']);
    expect(desk.live).toHaveLength(3);
    expect(desk.tree.every((n) => !n.queued && n.tabbable)).toBe(true);
    expect(vi.getTimerCount()).toBe(3);
    mocks.queue = true;
    const phone = render();
    expect(phone.shown).toEqual(['Three']);
    expect(vi.getTimerCount()).toBe(1);
  });
});
