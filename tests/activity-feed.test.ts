import { describe, it, expect } from 'vitest';
import { mergeActivity, relativeTime, type ActivityItem } from '@/lib/activity/feed';

const item = (id: string, at: string): ActivityItem => ({ id, kind: 'note', text: 'x', at });

describe('mergeActivity', () => {
  it('merges sources into one newest-first list', () => {
    const out = mergeActivity([
      [item('a', '2026-01-01T00:00:00Z'), item('b', '2026-01-03T00:00:00Z')],
      [item('c', '2026-01-02T00:00:00Z')],
    ]);
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('drops items without a timestamp and respects the limit', () => {
    const out = mergeActivity([[item('a', '2026-01-01T00:00:00Z'), { ...item('x', ''), at: '' }]], 5);
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('caps results at the limit, newest first', () => {
    const src = Array.from({ length: 10 }, (_, i) => item(`i${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    const out = mergeActivity([src], 3);
    expect(out.map((i) => i.id)).toEqual(['i9', 'i8', 'i7']);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  it('formats recent intervals', () => {
    // "now", not "just now": the shared ladder takes Intl.RelativeTimeFormat's
    // own word for a sub-minute gap, which is a real word in all eleven locales
    // where "just now" was English for everybody. Every other rung below is
    // byte-identical to what this file's own ladder produced.
    expect(relativeTime('2026-01-10T11:59:40Z', now)).toBe('now');
    expect(relativeTime('2026-01-10T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-01-10T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-01-08T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('2026-01-01T12:00:00Z', now)).toBe('1w ago');
  });
  it('falls back to a date for old items', () => {
    expect(relativeTime('2025-11-01T12:00:00Z', now)).toMatch(/Nov/);
  });

  // The feed row is rendered by a client component that binds this to
  // useLocale() (app/(app)/dashboard/activity/activity-feed.tsx), so the chip has
  // to actually change language. Asserting only en-US would pass over a helper
  // that ignores its third argument entirely.
  it('follows the reader', () => {
    expect(relativeTime('2026-01-10T11:30:00Z', now, 'de-DE')).toBe('vor 30 m');
    expect(relativeTime('2026-01-10T09:00:00Z', now, 'de-DE')).toBe('vor 3 Std.');
    expect(relativeTime('2026-01-10T11:59:40Z', now, 'fr-FR')).toBe('maintenant');
    expect(relativeTime('2025-11-01T12:00:00Z', now, 'de-DE')).toMatch(/Nov/);
  });
});
