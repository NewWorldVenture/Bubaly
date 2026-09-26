import { describe, expect, it, vi } from 'vitest';
import { activateOnKey } from '@/lib/a11y/activate-on-key';

// MAIN-F-D06: the handler that lets role="button" elements work like buttons.
const event = (key: string, onSelf = true) => {
  const el = {};
  return { key, target: onSelf ? el : {}, currentTarget: el, preventDefault: vi.fn() } as never;
};

describe('activateOnKey', () => {
  it('activates on Enter and on Space, and stops Space scrolling the page', () => {
    const fn = vi.fn();
    const space = event(' ');
    activateOnKey(fn)(event('Enter'));
    activateOnKey(fn)(space);
    expect(fn).toHaveBeenCalledTimes(2);
    expect((space as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const fn = vi.fn();
    for (const k of ['Tab', 'Escape', 'a', 'ArrowDown']) activateOnKey(fn)(event(k));
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves a key pressed on something inside the element to that thing', () => {
    const fn = vi.fn();
    activateOnKey(fn)(event('Enter', false));
    expect(fn).not.toHaveBeenCalled();
  });
});
