import { describe, it, expect } from 'vitest';
import {
  detectIgnoredReminders, detectStressWindows, detectChoreConflicts,
  detectRoutineAdherence, buildHardSignals,
  type ReminderRow, type ChoreRow, type RoutineRow,
} from '@/lib/intelligence/hard-signals';

const NOW = new Date('2026-07-07T12:00:00.000Z'); // Tuesday
const past = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('detectIgnoredReminders', () => {
  function rem(title: string, hoursAgo: number, o: Partial<ReminderRow> = {}): ReminderRow {
    return { id: Math.random().toString(), title, remindAt: past(hoursAgo), status: 'active', completedAt: null, memberId: null, ...o };
  }
  it('flags a reminder ignored 3+ times (grouping by normalized title)', () => {
    const sigs = detectIgnoredReminders([
      rem('Take out trash #1', 10), rem('Take out trash #2', 34), rem('Take out trash #3', 58),
      rem('Water plants #1', 5),
    ], NOW);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('ignored_reminder');
    expect(sigs[0].title).toContain('Take out trash');
    expect(sigs[0].evidence.count).toBe(3);
    expect(sigs[0].score).toBeGreaterThanOrEqual(70);
  });
  it('does not flag completed or future reminders', () => {
    expect(detectIgnoredReminders([
      rem('Done thing', 10, { status: 'done', completedAt: past(9) }),
      rem('Done thing', 20, { status: 'done', completedAt: past(19) }),
      rem('Done thing', 30, { status: 'done', completedAt: past(29) }),
      { id: 'f', title: 'Future', remindAt: new Date(NOW.getTime() + 3600_000).toISOString(), status: 'active', completedAt: null, memberId: null },
    ], NOW)).toEqual([]);
  });
  it('attributes to a member only when all instances share one', () => {
    const s = detectIgnoredReminders([
      rem('Pack lunch', 5, { memberId: 'm1' }), rem('Pack lunch', 10, { memberId: 'm1' }), rem('Pack lunch', 15, { memberId: 'm1' }),
    ], NOW);
    expect(s[0].memberId).toBe('m1');
  });
});

describe('detectStressWindows', () => {
  it('finds the highest-pressure day/part bucket (clashes weigh most)', () => {
    // Tuesday 18:00 = weekday evening.
    const evening = (n: number) => Array.from({ length: n }, () => ({ at: '2026-07-07T18:30:00.000Z' }));
    const sigs = detectStressWindows(evening(6), [{ at: '2026-07-07T18:30:00.000Z' }], [{ at: '2026-07-07T18:00:00.000Z' }], NOW);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('stress_window');
    expect(sigs[0].title).toMatch(/weekday evenings/i);
    expect(sigs[0].evidence.conflicts).toBe(1);
  });
  it('returns nothing when there is not enough pressure', () => {
    expect(detectStressWindows([{ at: '2026-07-07T09:00:00.000Z' }], [], [], NOW)).toEqual([]);
  });
});

describe('detectChoreConflicts', () => {
  function ca(choreId: string, o: Partial<ChoreRow> = {}): ChoreRow {
    return { choreId, choreTitle: 'Dishes', status: 'approved', disputed: false, memberId: 'm1', ...o };
  }
  it('flags a chore with rejections/disputes/hand-offs', () => {
    const sigs = detectChoreConflicts([
      ca('c1', { status: 'rejected', memberId: 'm1' }),
      ca('c1', { disputed: true, memberId: 'm2' }),
      ca('c1', { status: 'rejected', memberId: 'm3' }),
    ]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('chore_conflict');
    expect(sigs[0].evidence.rejected).toBe(2);
    expect(sigs[0].evidence.members).toBe(3);
  });
  it('ignores a smoothly-running chore', () => {
    expect(detectChoreConflicts([ca('c2'), ca('c2'), ca('c2')])).toEqual([]);
  });
});

describe('detectRoutineAdherence', () => {
  const routines: RoutineRow[] = [{ id: 'r1', name: 'Morning routine', weekdayMask: 0b0111110 }]; // Mon-Fri = 5/week
  it('flags a routine that is not sticking', () => {
    // Expected ~20 over 4 weeks; only 4 completions → 20% adherence.
    const completions = Array.from({ length: 4 }, (_, i) => ({ routineId: 'r1', occurredAt: past(i * 24) }));
    const sigs = detectRoutineAdherence(routines, completions, NOW, 4);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('routine_adherence');
    expect(sigs[0].evidence.adherencePct).toBe(20);
    expect(sigs[0].score).toBeGreaterThanOrEqual(70);
  });
  it('does not flag a routine that sticks well', () => {
    const completions = Array.from({ length: 18 }, (_, i) => ({ routineId: 'r1', occurredAt: past(i) }));
    expect(detectRoutineAdherence(routines, completions, NOW, 4)).toEqual([]);
  });
  it('skips routines too infrequent to judge', () => {
    expect(detectRoutineAdherence([{ id: 'r2', name: 'Weekly review', weekdayMask: 0b0000001 }], [], NOW, 2)).toEqual([]);
  });
});

describe('buildHardSignals', () => {
  it('runs every detector and ranks by severity', () => {
    const sigs = buildHardSignals({
      reminders: [
        { id: '1', title: 'Trash', remindAt: past(5), status: 'active', completedAt: null, memberId: null },
        { id: '2', title: 'Trash', remindAt: past(30), status: 'active', completedAt: null, memberId: null },
        { id: '3', title: 'Trash', remindAt: past(55), status: 'active', completedAt: null, memberId: null },
      ],
      events: Array.from({ length: 6 }, () => ({ at: '2026-07-07T18:30:00.000Z' })),
      conflicts: [{ at: '2026-07-07T18:30:00.000Z' }],
      overdue: [],
      chores: [
        { choreId: 'c1', choreTitle: 'Dishes', status: 'rejected', disputed: true, memberId: 'm1' },
        { choreId: 'c1', choreTitle: 'Dishes', status: 'rejected', disputed: true, memberId: 'm2' },
      ],
      routines: [{ id: 'r1', name: 'Bedtime', weekdayMask: 0b1111111 }],
      routineCompletions: [],
    }, NOW);
    const kinds = new Set(sigs.map((s) => s.kind));
    expect(kinds.has('ignored_reminder')).toBe(true);
    expect(kinds.has('stress_window')).toBe(true);
    expect(kinds.has('chore_conflict')).toBe(true);
    expect(kinds.has('routine_adherence')).toBe(true);
    // Ranked descending by score.
    for (let i = 1; i < sigs.length; i++) expect(sigs[i - 1].score).toBeGreaterThanOrEqual(sigs[i].score);
  });
});
