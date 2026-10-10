import { beforeEach, describe, expect, it, vi } from 'vitest';

// A modal dialog's own element is focusable: `Modal` and every overlay on
// useDialogBehavior give it `tabIndex={-1}`, so the hook can focus it when
// nothing inside is focusable yet. That also means a pointer click on anything
// inside that is not a control (the title, a paragraph, the panel's padding)
// moves focus to the dialog element itself. Chrome does exactly that.
//
// The trap answered Shift+Tab only from the first control or from outside the
// dialog. From the dialog element, the browser's own Shift+Tab went to the
// last focusable BEFORE the dialog in document order: a control in the page
// behind it, which `aria-modal="true"` has just told assistive technology is
// inert. Reproduced on main in Chromium: the cookie preferences dialog left
// focus on the footer's "Privacy choices" button, and the signed-in "Add
// favorite" dialog left it on "Ask the AI assistant"
// (tests/e2e/a-modal-keeps-shift-tab-inside.spec.ts).
//
// This drives the hook's real effect with a minimal DOM: the effect is the
// hook's, the elements are stand-ins that record focus.
const mocks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (fn: () => void | (() => void)) => { mocks.effects.push(fn); },
}));

type Node = { name: string; offsetParent: unknown; focus: () => void; closest: () => null; isConnected: boolean };
const keyListeners: Array<(e: KeyboardEvent) => void> = [];
const doc = {
  activeElement: null as unknown,
  body: { style: { overflow: '' } },
  addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => { if (type === 'keydown') keyListeners.push(fn); },
  removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
    const at = keyListeners.indexOf(fn);
    if (type === 'keydown' && at >= 0) keyListeners.splice(at, 1);
  },
  getElementById: () => null,
  querySelector: () => null,
};
(globalThis as unknown as { document: typeof doc }).document = doc;

const node = (name: string): Node => ({
  name, offsetParent: {}, isConnected: true, closest: () => null,
  focus() { doc.activeElement = this; },
});
const trigger = node('trigger');
const first = node('close');
const middle = node('field');
const last = node('save');
const inside = [first, middle, last];
const dialog = Object.assign(node('dialog'), {
  contains: (n: unknown) => n === dialog || inside.includes(n as Node),
  querySelectorAll: () => inside,
});

const { useDialogBehavior } = await import('@/lib/a11y/use-dialog-behavior');

function press(key: 'Tab', shiftKey: boolean) {
  const preventDefault = vi.fn();
  for (const fn of [...keyListeners]) fn({ key, shiftKey, preventDefault } as unknown as KeyboardEvent);
  return preventDefault;
}

let cleanup: void | (() => void);
beforeEach(() => {
  if (typeof cleanup === 'function') cleanup();
  mocks.effects.length = 0;
  doc.activeElement = trigger;
  useDialogBehavior({ current: dialog as unknown as HTMLElement }, true, { onClose: () => {} });
  cleanup = mocks.effects[0]();
});

describe('a modal dialog’s own element is not a way out', () => {
  it('opens on its first control', () => {
    expect(doc.activeElement).toBe(first);
  });

  it('Shift+Tab from the dialog element (where a click on its text puts focus) goes to its last control', () => {
    dialog.focus();
    const prevented = press('Tab', true);
    expect(prevented).toHaveBeenCalledOnce();
    expect(doc.activeElement).toBe(last);
  });

  it('Shift+Tab from the first control still wraps to the last', () => {
    first.focus();
    expect(press('Tab', true)).toHaveBeenCalledOnce();
    expect(doc.activeElement).toBe(last);
  });

  it('Tab from the last control still wraps to the first', () => {
    last.focus();
    expect(press('Tab', false)).toHaveBeenCalledOnce();
    expect(doc.activeElement).toBe(first);
  });

  it('between controls, and Tab from the dialog element, the browser moves focus (it stays inside on its own)', () => {
    middle.focus();
    expect(press('Tab', true)).not.toHaveBeenCalled();
    expect(press('Tab', false)).not.toHaveBeenCalled();
    dialog.focus();
    expect(press('Tab', false)).not.toHaveBeenCalled();
  });
});
