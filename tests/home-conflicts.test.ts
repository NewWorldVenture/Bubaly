import { describe, it, expect } from 'vitest';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';

const ev = (id: string, start: string, end: string | null, assignee: string | null, all_day = false): ConflictEvent =>
  ({ id, title: id, starts_at: start, ends_at: end, all_day, assignee_id: assignee });

describe('detectConflicts', () => {
  it.each(['inside', 'same time', 'bridging'] as const)('does not turn explicit point events into an hour-long conflict: %s', position => {
    const point = ev('point', '2026-07-01T15:30:00Z', '2026-07-01T15:30:00Z', 'm1');
    const events = position === 'same time' ? [point, { ...point, id: 'second' }]
      : position === 'inside' ? [ev('meeting', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1'), point]
      : [ev('earlier', '2026-07-01T15:00:00Z', '2026-07-01T15:45:00Z', 'm1'), point, ev('later', '2026-07-01T16:00:00Z', '2026-07-01T17:00:00Z', 'm1')];
    const before = structuredClone(events); expect(detectConflicts(events)).toEqual([]); expect(events).toEqual(before);
  });

  it.each([null, 'invalid', '2026-07-01T14:00:00Z'])('retains legacy missing/invalid/backward duration fallback: %s', end => {
    expect(detectConflicts([ev('legacy', '2026-07-01T15:00:00Z', end, 'm1'), ev('meeting', '2026-07-01T15:30:00Z', '2026-07-01T16:00:00Z', 'm1')])[0].eventIds).toEqual(['legacy', 'meeting']);
  });

  it('retains a positive overlap cluster around a zero-duration entry', () => {
    expect(detectConflicts([ev('a', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1'), ev('point', '2026-07-01T15:15:00Z', '2026-07-01T15:15:00Z', 'm1'),
      ev('b', '2026-07-01T15:30:00Z', '2026-07-01T17:00:00Z', 'm1')])[0].eventIds).toEqual(['a', 'b']);
  });
  it('flags two overlapping events for the same person', () => {
    const out = detectConflicts([
      ev('a', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1'),
      ev('b', '2026-07-01T15:30:00Z', '2026-07-01T16:30:00Z', 'm1'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ assigneeId: 'm1', eventIds: ['a', 'b'] });
  });

  it('does not flag non-overlapping or back-to-back events', () => {
    expect(detectConflicts([
      ev('a', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1'),
      ev('b', '2026-07-01T16:00:00Z', '2026-07-01T17:00:00Z', 'm1'), // starts exactly when a ends
    ])).toEqual([]);
  });

  it('does not flag overlaps across different people', () => {
    expect(detectConflicts([
      ev('a', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1'),
      ev('b', '2026-07-01T15:30:00Z', '2026-07-01T16:30:00Z', 'm2'),
    ])).toEqual([]);
  });

  it('ignores all-day and unassigned events', () => {
    expect(detectConflicts([
      ev('a', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', 'm1', true),
      ev('b', '2026-07-01T15:30:00Z', '2026-07-01T16:30:00Z', 'm1', true),
      ev('c', '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z', null),
      ev('d', '2026-07-01T15:30:00Z', '2026-07-01T16:30:00Z', null),
    ])).toEqual([]);
  });

  it('clusters 3 overlapping events into one conflict and uses default duration when ends_at is missing', () => {
    const out = detectConflicts([
      ev('a', '2026-07-01T15:00:00Z', null, 'm1'),          // 15:00–16:00 (default 60m)
      ev('b', '2026-07-01T15:30:00Z', '2026-07-01T17:00:00Z', 'm1'),
      ev('c', '2026-07-01T16:30:00Z', '2026-07-01T18:00:00Z', 'm1'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].eventIds).toEqual(['a', 'b', 'c']);
    expect(out[0].startsAt).toBe('2026-07-01T15:00:00Z');
  });
});
