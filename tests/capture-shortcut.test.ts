import { describe, it, expect } from 'vitest';
import { isTypingTarget, isOpenCaptureKey, isSaveHotkey } from '@/lib/capture/shortcut';

describe('isTypingTarget', () => {
  it('is true for form fields and contenteditable', () => {
    expect(isTypingTarget('INPUT')).toBe(true);
    expect(isTypingTarget('textarea')).toBe(true);
    expect(isTypingTarget('SELECT')).toBe(true);
    expect(isTypingTarget('DIV', true)).toBe(true);
  });
  it('is false for non-editable elements', () => {
    expect(isTypingTarget('DIV')).toBe(false);
    expect(isTypingTarget('BUTTON')).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('isOpenCaptureKey', () => {
  it('matches a bare c', () => {
    expect(isOpenCaptureKey({ key: 'c' })).toBe(true);
    expect(isOpenCaptureKey({ key: 'C' })).toBe(true);
  });
  it('ignores c with modifiers (incl. shift) and other keys', () => {
    expect(isOpenCaptureKey({ key: 'c', metaKey: true })).toBe(false);
    expect(isOpenCaptureKey({ key: 'c', ctrlKey: true })).toBe(false);
    expect(isOpenCaptureKey({ key: 'c', shiftKey: true })).toBe(false);
    expect(isOpenCaptureKey({ key: 'x' })).toBe(false);
  });
});

describe('isSaveHotkey', () => {
  it('matches cmd/ctrl + Enter only', () => {
    expect(isSaveHotkey({ key: 'Enter', metaKey: true })).toBe(true);
    expect(isSaveHotkey({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(isSaveHotkey({ key: 'Enter' })).toBe(false);
    expect(isSaveHotkey({ key: 'a', metaKey: true })).toBe(false);
  });
});
