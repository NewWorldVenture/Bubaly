import { describe, it, expect } from 'vitest';
import { findOverlaps, type TimedEvent } from '@/lib/moments/conflicts';

const ev = (id: string, title: string, starts_at: string, ends_at: string | null = null, all_day = false): TimedEvent =>
  ({ id, title, starts_at, ends_at, all_day });

describe('findOverlaps', () => {
  it('flags two events whose windows overlap, both directions', () => {
    const res = findOverlaps([
      ev('a', "Mia's game", '2026-07-04T15:00:00', '2026-07-04T16:30:00'),
      ev('b', "Sam's recital", '2026-07-04T16:00:00', '2026-07-04T17:00:00'),
    ]);
    expect(res['a']).toEqual(["Sam's recital"]);
    expect(res['b']).toEqual(["Mia's game"]);
  });

  it('does NOT flag merely-adjacent events (end == next start)', () => {
    const res = findOverlaps([
      ev('a', 'A', '2026-07-04T15:00:00', '2026-07-04T16:00:00'),
      ev('b', 'B', '2026-07-04T16:00:00', '2026-07-04T17:00:00'),
    ]);
    expect(res).toEqual({});
  });

  it('uses a 60-min default window when an event has no end time', () => {
    const res = findOverlaps([
      ev('a', 'A', '2026-07-04T15:00:00'),                       // → 15:00–16:00
      ev('b', 'B', '2026-07-04T15:30:00'),                       // → 15:30–16:30
    ]);
    expect(res['a']).toEqual(['B']);
    expect(res['b']).toEqual(['A']);
  });

  it('ignores all-day events and undated rows', () => {
    const res = findOverlaps([
      ev('a', 'Holiday', '2026-07-04T00:00:00', null, true),
      ev('b', 'Party', '2026-07-04T12:00:00', '2026-07-04T18:00:00'),
      ev('c', 'Broken', 'not-a-date'),
    ]);
    expect(res).toEqual({});
  });

  it('collects and sorts multiple clashers for one event', () => {
    const res = findOverlaps([
      ev('a', 'Center', '2026-07-04T15:00:00', '2026-07-04T18:00:00'),
      ev('b', 'Zebra', '2026-07-04T15:30:00', '2026-07-04T16:00:00'),
      ev('c', 'Apple', '2026-07-04T16:30:00', '2026-07-04T17:00:00'),
    ]);
    expect(res['a']).toEqual(['Apple', 'Zebra']);
  });
});
