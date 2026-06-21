import { describe, expect, it } from 'vitest';
import { detectConflicts, quickFixMoveAfter, eventEnd, type TimedEvent } from '@/lib/family/conflicts';

const ev = (id: string, start: string, end: string | null, all_day = false): TimedEvent => ({
  id, title: id, starts_at: start, ends_at: end, all_day,
});

describe('detectConflicts', () => {
  it('finds a simple overlap', () => {
    const c = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', '2026-06-21T11:00:00Z'),
      ev('b', '2026-06-21T10:30:00Z', '2026-06-21T11:30:00Z'),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].a.id).toBe('a');
    expect(c[0].b.id).toBe('b');
    expect(c[0].overlapMinutes).toBe(30);
  });

  it('ignores back-to-back (touching) events', () => {
    const c = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', '2026-06-21T11:00:00Z'),
      ev('b', '2026-06-21T11:00:00Z', '2026-06-21T12:00:00Z'),
    ]);
    expect(c).toHaveLength(0);
  });

  it('ignores all-day events', () => {
    const c = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', '2026-06-21T23:00:00Z', true),
      ev('b', '2026-06-21T10:30:00Z', '2026-06-21T11:30:00Z'),
    ]);
    expect(c).toHaveLength(0);
  });

  it('defaults missing end to 1 hour', () => {
    const e = ev('a', '2026-06-21T10:00:00Z', null);
    expect(eventEnd(e)).toBe(new Date('2026-06-21T11:00:00Z').getTime());
    const c = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', null),
      ev('b', '2026-06-21T10:15:00Z', '2026-06-21T10:45:00Z'),
    ]);
    expect(c).toHaveLength(1);
  });

  it('detects multiple overlaps among three events', () => {
    const c = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', '2026-06-21T12:00:00Z'),
      ev('b', '2026-06-21T10:30:00Z', '2026-06-21T11:00:00Z'),
      ev('c', '2026-06-21T11:30:00Z', '2026-06-21T12:30:00Z'),
    ]);
    // a–b and a–c overlap; b–c do not
    expect(c).toHaveLength(2);
  });

  it('returns nothing for non-overlapping events', () => {
    const c = detectConflicts([
      ev('a', '2026-06-21T08:00:00Z', '2026-06-21T09:00:00Z'),
      ev('b', '2026-06-21T10:00:00Z', '2026-06-21T11:00:00Z'),
    ]);
    expect(c).toHaveLength(0);
  });
});

describe('quickFixMoveAfter', () => {
  it('moves the later event to start when the earlier ends, preserving duration', () => {
    const conflicts = detectConflicts([
      ev('a', '2026-06-21T10:00:00Z', '2026-06-21T11:00:00Z'),
      ev('b', '2026-06-21T10:30:00Z', '2026-06-21T11:30:00Z'), // 1h duration
    ]);
    const fix = quickFixMoveAfter(conflicts[0]);
    expect(fix).not.toBeNull();
    expect(fix!.eventId).toBe('b');
    expect(fix!.startsAtIso).toBe('2026-06-21T11:00:00.000Z');
    expect(fix!.endsAtIso).toBe('2026-06-21T12:00:00.000Z');
  });
});
