import { describe, it, expect } from 'vitest';
import { groupByMonth, countMemories, type MemoryItem } from '@/lib/memories/timeline';
import {
  buildTimeline, memoryStats, sharedWithYou, relativeDay, relativeTime,
  type AlbumRow, type PhotoRow, type MemberLite,
} from '@/lib/memories/memories';

const item = (id: string, date: string): MemoryItem => ({ id, kind: 'photo', title: id, date });

const album = (id: string, created_at: string, kind = 'highlight'): AlbumRow => ({
  id, name: id, cover_url: null, kind, is_shared: true, photo_count: 3, created_at, created_by: null,
});
const photo = (id: string, uploaded_by: string | null, created_at: string, media_type = 'image'): PhotoRow => ({
  id, album_id: null, uploaded_by, url: null, thumbnail_url: null, caption: null, media_type,
  taken_at: created_at, created_at,
});
const member = (user_id: string, display_name: string): MemberLite => ({
  id: `m-${user_id}`, user_id, display_name, color: null,
});

describe('groupByMonth', () => {
  it('groups into months newest-first with newest item first', () => {
    const months = groupByMonth([
      item('a', '2026-03-02'),
      item('b', '2026-03-20'),
      item('c', '2026-01-15'),
    ]);
    expect(months.map((m) => m.key)).toEqual(['2026-03', '2026-01']);
    expect(months[0].items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(months[0].label).toMatch(/March 2026/);
  });

  it('handles full timestamps and drops undated items', () => {
    const months = groupByMonth([
      item('a', '2026-05-01T12:00:00Z'),
      item('x', 'garbage'),
    ]);
    expect(countMemories(months)).toBe(1);
    expect(months[0].key).toBe('2026-05');
  });
});

describe('countMemories', () => {
  it('sums across months', () => {
    expect(countMemories(groupByMonth([item('a', '2026-01-01'), item('b', '2026-02-01')]))).toBe(2);
    expect(countMemories([])).toBe(0);
  });
});

describe('relativeDay', () => {
  const now = new Date('2026-07-01T12:00:00');
  it('names Today / Yesterday and recent weekdays', () => {
    expect(relativeDay('2026-07-01T09:00:00', now)).toBe('Today');
    expect(relativeDay('2026-06-30T09:00:00', now)).toBe('Yesterday');
    // 2026-06-27 is a Saturday, 4 days before July 1.
    expect(relativeDay('2026-06-27T09:00:00', now)).toBe('Last Saturday');
  });
  it('falls back to an absolute date past a week', () => {
    expect(relativeDay('2026-05-01T09:00:00', now)).toMatch(/May 1, 2026/);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  it('formats sub-day deltas compactly', () => {
    expect(relativeTime('2026-07-01T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-07-01T11:30:00Z', now)).toBe('30m ago');
    expect(relativeTime('2026-07-01T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-06-29T12:00:00Z', now)).toBe('2d ago');
  });
});

describe('buildTimeline', () => {
  const now = new Date('2026-07-01T12:00:00');
  it('sorts newest first and caps the list', () => {
    const rows = buildTimeline([
      album('old', '2026-01-01T00:00:00'),
      album('new', '2026-06-30T00:00:00'),
      album('mid', '2026-04-01T00:00:00'),
    ], now);
    expect(rows.map((r) => r.album.id)).toEqual(['new', 'mid', 'old']);
    expect(rows[0].relative).toBe('Yesterday');
    expect(buildTimeline(Array.from({ length: 30 }, (_, i) => album(`a${i}`, '2026-06-01T00:00:00')), now, 12)).toHaveLength(12);
  });
});

describe('memoryStats', () => {
  it('returns four ordered tiles carrying the counts', () => {
    const stats = memoryStats({ photos: 12, videos: 3, albums: 5, memories: 40 });
    expect(stats.map((s) => s.label)).toEqual(['Photos', 'Videos', 'Albums', 'Memories Added']);
    expect(stats.map((s) => s.value)).toEqual([12, 3, 5, 40]);
    expect(typeof stats[0].icon).toBe('object'); // lucide forwardRef component
    expect(stats[0].tint).toContain('brand');
  });
});

describe('sharedWithYou', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  const members = [member('u-me', 'Me'), member('u-al', 'Alex'), member('u-jo', 'Jordan')];
  it('groups others’ recent uploads, newest sharer first, excluding me', () => {
    const rows = sharedWithYou([
      photo('p1', 'u-me', '2026-06-30T10:00:00Z'), // mine → excluded
      photo('p2', 'u-al', '2026-06-30T10:00:00Z'),
      photo('p3', 'u-al', '2026-06-30T11:00:00Z'),
      photo('p4', 'u-jo', '2026-06-29T10:00:00Z', 'video'),
      photo('p5', null, '2026-06-30T10:00:00Z'), // no uploader → excluded
    ], members, 'u-me', now);
    expect(rows.map((r) => r.name)).toEqual(['Alex', 'Jordan']);
    expect(rows[0].label).toBe('2 photos');
    expect(rows[0].at).toBe('2026-06-30T11:00:00Z');
    expect(rows[1].label).toBe('a video');
  });
  it('drops uploads older than the recency window', () => {
    const rows = sharedWithYou([photo('old', 'u-al', '2026-01-01T00:00:00Z')], members, 'u-me', now);
    expect(rows).toHaveLength(0);
  });
  it('combines photos and videos in one label', () => {
    const rows = sharedWithYou([
      photo('a', 'u-al', '2026-06-30T10:00:00Z'),
      photo('b', 'u-al', '2026-06-30T10:05:00Z', 'video'),
    ], members, 'u-me', now);
    expect(rows[0].label).toBe('a photo and a video');
  });
});
