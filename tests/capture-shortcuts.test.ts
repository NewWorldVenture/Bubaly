import { describe, it, expect } from 'vitest';
import {
  sanitizeShortcutKeys, resolveShortcutKeys,
  DEFAULT_CAPTURE_SHORTCUTS, MAX_CAPTURE_SHORTCUTS,
} from '@/lib/capture/shortcuts';

const VALID = ['calendar', 'tasks', 'grocery', 'home', 'health', 'trip', 'notes', 'meals', 'reminders', 'documents', 'wallet', 'pets', 'goals'];

describe('sanitizeShortcutKeys', () => {
  it('keeps valid keys in order', () => {
    expect(sanitizeShortcutKeys(['tasks', 'calendar'], VALID)).toEqual(['tasks', 'calendar']);
  });
  it('drops unknown keys when validKeys is given', () => {
    expect(sanitizeShortcutKeys(['tasks', 'nope', 'calendar'], VALID)).toEqual(['tasks', 'calendar']);
  });
  it('allows any non-empty string when validKeys is omitted (server guard)', () => {
    expect(sanitizeShortcutKeys(['tasks', 'whatever'])).toEqual(['tasks', 'whatever']);
  });
  it('dedupes (first wins) and trims', () => {
    expect(sanitizeShortcutKeys([' tasks ', 'tasks', 'calendar'], VALID)).toEqual(['tasks', 'calendar']);
  });
  it('drops non-strings and blanks', () => {
    expect(sanitizeShortcutKeys(['tasks', 2, null, '', '   ', {}], VALID as string[])).toEqual(['tasks']);
  });
  it('caps at max', () => {
    const many = Array.from({ length: 20 }, (_, i) => `k${i}`);
    expect(sanitizeShortcutKeys(many, undefined, 5)).toHaveLength(5);
    expect(sanitizeShortcutKeys(VALID, VALID).length).toBeLessThanOrEqual(MAX_CAPTURE_SHORTCUTS);
  });
  it('returns [] for non-arrays', () => {
    expect(sanitizeShortcutKeys(null, VALID)).toEqual([]);
    expect(sanitizeShortcutKeys('tasks', VALID)).toEqual([]);
    expect(sanitizeShortcutKeys(undefined, VALID)).toEqual([]);
  });
});

describe('resolveShortcutKeys', () => {
  it('falls back to defaults when empty/invalid', () => {
    expect(resolveShortcutKeys(null, VALID)).toEqual(DEFAULT_CAPTURE_SHORTCUTS);
    expect(resolveShortcutKeys([], VALID)).toEqual(DEFAULT_CAPTURE_SHORTCUTS);
    expect(resolveShortcutKeys(['nope'], VALID)).toEqual(DEFAULT_CAPTURE_SHORTCUTS);
  });
  it('uses a valid saved layout as-is', () => {
    expect(resolveShortcutKeys(['meals', 'wallet'], VALID)).toEqual(['meals', 'wallet']);
  });
});
