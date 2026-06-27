import { describe, it, expect } from 'vitest';
import {
  earlyReminderLabel, earlyReminderAt, parseTags, formatTags,
  normalizeSubtasks, newSubtask, subtaskProgress, isValidHttpUrl,
} from '@/lib/reminders/details';

describe('earlyReminderLabel', () => {
  it('labels known and derived lead times', () => {
    expect(earlyReminderLabel(null)).toBe('None');
    expect(earlyReminderLabel(0)).toBe('At time of event');
    expect(earlyReminderLabel(15)).toBe('15 minutes before');
    expect(earlyReminderLabel(60)).toBe('1 hour before');
    expect(earlyReminderLabel(1440)).toBe('1 day before');
    expect(earlyReminderLabel(10080)).toBe('1 week before');
    expect(earlyReminderLabel(180)).toBe('3 hours before'); // derived
  });
});

describe('earlyReminderAt', () => {
  it('subtracts the lead minutes from the due time', () => {
    const at = earlyReminderAt('2026-07-01T09:00:00.000Z', 30);
    expect(at.toISOString()).toBe('2026-07-01T08:30:00.000Z');
  });
});

describe('parseTags', () => {
  it('cleans, strips #, dedupes, drops blanks', () => {
    expect(parseTags('#home, Errand , errand, , #Bills')).toEqual(['home', 'Errand', 'Bills']);
    expect(parseTags('')).toEqual([]);
    expect(formatTags(['a', 'b'])).toBe('a, b');
  });
});

describe('normalizeSubtasks', () => {
  it('coerces stored JSON to clean subtasks', () => {
    const out = normalizeSubtasks([
      { id: 's1', title: 'Buy milk', done: true },
      { title: 'Pay bill' },        // missing id → generated
      { title: '   ' },             // blank → dropped
      'garbage',                    // non-object → dropped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 's1', title: 'Buy milk', done: true });
    expect(out[1].title).toBe('Pay bill');
    expect(out[1].done).toBe(false);
    expect(out[1].id).toBeTruthy();
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeSubtasks(null)).toEqual([]);
    expect(normalizeSubtasks({})).toEqual([]);
  });
});

describe('subtaskProgress', () => {
  it('counts done vs total', () => {
    expect(subtaskProgress([newSubtask('a'), { ...newSubtask('b'), done: true }])).toEqual({ done: 1, total: 2 });
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe('isValidHttpUrl', () => {
  it('accepts http(s), rejects the rest', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl('http://a.b/c?d=1')).toBe(true);
    expect(isValidHttpUrl('ftp://x')).toBe(false);
    expect(isValidHttpUrl('not a url')).toBe(false);
  });
});
