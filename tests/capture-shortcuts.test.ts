import { describe, it, expect } from 'vitest';
import {
  sanitizeShortcutKeys,
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

describe('capture shortcut limits', () => {
  it('allows 10 rows of the 3-column grid', () => {
    expect(MAX_CAPTURE_SHORTCUTS).toBe(30);
  });
  it('defaults are a valid subset of the max', () => {
    expect(DEFAULT_CAPTURE_SHORTCUTS.length).toBeGreaterThan(0);
    expect(DEFAULT_CAPTURE_SHORTCUTS.length).toBeLessThanOrEqual(MAX_CAPTURE_SHORTCUTS);
  });
  it('an explicitly-empty layout sanitizes to [] (no default fallback)', () => {
    // The Capture grid respects a deliberately-emptied layout; only a
    // never-saved (null) layout uses the defaults — that branch lives in the
    // component, not here.
    expect(sanitizeShortcutKeys([], VALID)).toEqual([]);
  });
});
