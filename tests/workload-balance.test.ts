import { describe, it, expect } from 'vitest';
import {
  computeWorkload, rebalanceSuggestions, shareTrend, isoWeekStart,
  type WorkloadMember, type WorkloadChoreAssignment,
} from '@/lib/workload/balance';

const members: WorkloadMember[] = [
  { id: 'mom', name: 'Mom', role: 'parent' },
  { id: 'dad', name: 'Dad', role: 'parent' },
  { id: 'kid', name: 'Maya', role: 'child' },
];

function chore(id: string, memberId: string, minutes: number, status = 'todo'): WorkloadChoreAssignment {
  return { id, choreId: 'c-' + id, memberId, status, choreTitle: 'Chore ' + id, estMinutes: minutes, points: 10 };
}

describe('computeWorkload', () => {
  it('ranks the heaviest member first and computes shares that sum to ~100', () => {
    const r = computeWorkload(members, [
      chore('a', 'mom', 60), chore('b', 'mom', 60), chore('c', 'dad', 30),
    ], [{ assignedToId: 'mom', isDone: false }], [{ createdBy: 'mom' }]);
    expect(r.loads[0].memberId).toBe('mom');
    const sum = r.loads.reduce((s, l) => s + l.sharePct, 0);
    expect(sum).toBeGreaterThan(98);
    expect(sum).toBeLessThan(102);
  });

  it('flags overload and says so in the headline', () => {
    const r = computeWorkload(members, [
      chore('a', 'mom', 120), chore('b', 'mom', 90), chore('c', 'dad', 20),
    ], [], []);
    expect(r.loads[0].overloaded).toBe(true);
    expect(r.headline).toContain('Mom');
    expect(r.fairness).toBeLessThan(80);
  });

  it('is calm when balanced and safe when empty', () => {
    const even = computeWorkload(members, [
      chore('a', 'mom', 30), chore('b', 'dad', 30), chore('c', 'kid', 30),
    ], [], []);
    expect(even.fairness).toBeGreaterThanOrEqual(80);
    expect(even.suggestions).toHaveLength(0);

    const empty = computeWorkload(members, [], [], []);
    expect(empty.fairness).toBe(100);
    expect(empty.headline).toContain('No load');
  });

  it('counts invisible labor (organizing events) toward load', () => {
    const r = computeWorkload(members, [chore('a', 'dad', 30)], [],
      Array.from({ length: 10 }, () => ({ createdBy: 'mom' })));
    expect(r.loads[0].memberId).toBe('mom');   // organizer outranks the 30-min chore
  });
});

describe('rebalanceSuggestions', () => {
  it('moves the biggest OPEN chores from heaviest to lightest with a human reason', () => {
    const assignments = [
      chore('big', 'mom', 90), chore('mid', 'mom', 45), chore('done', 'mom', 60, 'done'),
      chore('d1', 'dad', 10),
    ];
    const r = computeWorkload(members, assignments, [], []);
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions[0].choreTitle).toBe('Chore big');
    expect(r.suggestions[0].fromName).toBe('Mom');
    expect(r.suggestions.map(s => s.assignmentId)).not.toContain('done');
    expect(r.suggestions[0].reason).toMatch(/evens it out/);
  });

  it('never auto-moves an adult load onto a child', () => {
    const twoAdultsKid = computeWorkload(members, [
      chore('a', 'mom', 120), chore('b', 'mom', 60),
    ], [], []);
    for (const s of twoAdultsKid.suggestions) expect(s.toMemberId).not.toBe('kid');
  });

  it('suggests nothing when there is no meaningful imbalance', () => {
    const loads = computeWorkload(members, [
      chore('a', 'mom', 30), chore('b', 'dad', 30), chore('c', 'kid', 28),
    ], [], []).loads;
    expect(rebalanceSuggestions(loads, [])).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('shareTrend groups by member in week order', () => {
    const t = shareTrend([
      { memberId: 'mom', weekStart: '2026-07-06', sharePct: 60 },
      { memberId: 'mom', weekStart: '2026-06-29', sharePct: 55 },
      { memberId: 'dad', weekStart: '2026-07-06', sharePct: 40 },
    ]);
    expect(t.get('mom')!.map(x => x.weekStart)).toEqual(['2026-06-29', '2026-07-06']);
    expect(t.get('dad')).toHaveLength(1);
  });

  it('isoWeekStart returns the Monday for any weekday', () => {
    expect(isoWeekStart(new Date('2026-07-12T10:00:00Z'))).toBe('2026-07-06'); // Sunday → prior Monday
    expect(isoWeekStart(new Date('2026-07-06T00:00:00Z'))).toBe('2026-07-06'); // Monday → itself
  });
});
