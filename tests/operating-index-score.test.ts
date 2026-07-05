import { describe, it, expect } from 'vitest';
import {
  computeOperatingIndex, bandFor, mostLoaded, compositeTrend, dimensionsToRecord,
  type HouseholdSnapshot,
} from '@/lib/operating-index/score';

// A calm, empty household: nothing scheduled, nothing owed. Should read as
// healthy ("calm, not failing"), NOT as a zero score.
function calmSnapshot(): HouseholdSnapshot {
  return {
    memberCount: 4,
    upcomingEvents: 0, upcomingEventsOwned: 0, eventsMissingInfo: 0, overdueReminders: 0,
    conflicts: 0,
    billsDueSoon: 0, billsCovered: 0, overspentBudgets: 0, negativeBalances: 0,
    expiringDocs: 0, overdueMaintenance: 0, lowInventory: 0,
    pendingApprovals: 0, openVotes: 0, unreadThreads: 0,
    choresAssignedRecently: 0, choresCompletedRecently: 0, overdueTasks: 0,
    activeGoals: 0, goalsOnTrack: 0,
    memberLoads: [],
  };
}

describe('computeOperatingIndex', () => {
  it('a calm/empty household scores as thriving, not zero', () => {
    const idx = computeOperatingIndex(calmSnapshot());
    expect(idx.composite).toBe(100);
    expect(idx.band).toBe('thriving');
    expect(idx.suggestions).toHaveLength(0);
    expect(idx.dimensions).toHaveLength(7);
  });

  it('penalizes conflicts, overdue reminders, uncovered bills, negative balances', () => {
    const s = calmSnapshot();
    s.conflicts = 2;
    s.overdueReminders = 3;
    s.billsDueSoon = 4; s.billsCovered = 1;
    s.negativeBalances = 1;
    const idx = computeOperatingIndex(s);
    expect(idx.composite).toBeLessThan(100);
    const stability = idx.dimensions.find((d) => d.id === 'stability')!;
    const financial = idx.dimensions.find((d) => d.id === 'financial')!;
    expect(stability.score).toBeLessThan(100);
    expect(financial.score).toBeLessThan(100);
    // High-impact suggestions surface first.
    const ids = idx.suggestions.map((x) => x.id);
    expect(ids).toContain('resolve-conflicts');
    expect(ids).toContain('clear-overdue-reminders');
    expect(ids).toContain('fix-negative-balances');
    expect(idx.suggestions[0].impact).toBe('high');
  });

  it('scores are clamped to 0..100 even under heavy load', () => {
    const s = calmSnapshot();
    s.conflicts = 50; s.overdueReminders = 50; s.negativeBalances = 20;
    s.expiringDocs = 30; s.overdueMaintenance = 30; s.lowInventory = 30;
    s.pendingApprovals = 40; s.openVotes = 40; s.unreadThreads = 40;
    s.overdueTasks = 40;
    const idx = computeOperatingIndex(s);
    for (const d of idx.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
    expect(idx.composite).toBeGreaterThanOrEqual(0);
    expect(idx.band).toBe('overloaded');
  });

  it('planning reflects the owned-event ratio', () => {
    const s = calmSnapshot();
    s.upcomingEvents = 10; s.upcomingEventsOwned = 5;
    const planning = computeOperatingIndex(s).dimensions.find((d) => d.id === 'planning')!;
    expect(planning.score).toBe(50);
    expect(planning.summary).toContain('5/10');
  });

  it('routine reflects the completed-chore ratio minus overdue penalty', () => {
    const s = calmSnapshot();
    s.choresAssignedRecently = 10; s.choresCompletedRecently = 8; s.overdueTasks = 1;
    const routine = computeOperatingIndex(s).dimensions.find((d) => d.id === 'routine')!;
    expect(routine.score).toBe(80 - 7); // 73
  });

  it('is deterministic for a given snapshot + now', () => {
    const s = calmSnapshot();
    s.conflicts = 1; s.overdueTasks = 2;
    const now = new Date('2026-07-05T12:00:00Z');
    const a = computeOperatingIndex(s, now);
    const b = computeOperatingIndex(s, now);
    expect(a).toEqual(b);
  });
});

describe('bandFor', () => {
  it('maps composites to bands at the documented thresholds', () => {
    expect(bandFor(100)).toBe('thriving');
    expect(bandFor(85)).toBe('thriving');
    expect(bandFor(84)).toBe('steady');
    expect(bandFor(70)).toBe('steady');
    expect(bandFor(69)).toBe('stretched');
    expect(bandFor(50)).toBe('stretched');
    expect(bandFor(49)).toBe('overloaded');
    expect(bandFor(0)).toBe('overloaded');
  });
});

describe('mostLoaded', () => {
  it('returns null when the load is even or the family is tiny', () => {
    expect(mostLoaded([])).toBeNull();
    expect(mostLoaded([{ memberId: 'a', name: 'A', upcoming: 9, openTasks: 9 }])).toBeNull();
    expect(mostLoaded([
      { memberId: 'a', name: 'A', upcoming: 3, openTasks: 2 },
      { memberId: 'b', name: 'B', upcoming: 2, openTasks: 3 },
    ])).toBeNull(); // 5 vs 5, not 1.6x ahead
  });

  it('flags a clearly-overloaded member', () => {
    const top = mostLoaded([
      { memberId: 'a', name: 'Mom', upcoming: 6, openTasks: 4 }, // 10
      { memberId: 'b', name: 'Dad', upcoming: 1, openTasks: 1 }, // 2
      { memberId: 'c', name: 'Kid', upcoming: 0, openTasks: 1 }, // 1
    ]);
    expect(top?.name).toBe('Mom');
  });

  it('does not flag when top is busy but the family is broadly busy', () => {
    expect(mostLoaded([
      { memberId: 'a', name: 'A', upcoming: 6, openTasks: 4 }, // 10
      { memberId: 'b', name: 'B', upcoming: 5, openTasks: 4 }, // 9
    ])).toBeNull();
  });
});

describe('helpers', () => {
  it('dimensionsToRecord serializes to a {id: score} map', () => {
    const idx = computeOperatingIndex(calmSnapshot());
    const rec = dimensionsToRecord(idx.dimensions);
    expect(rec.planning).toBe(100);
    expect(Object.keys(rec)).toHaveLength(7);
  });

  it('compositeTrend returns null with no prior, else the delta', () => {
    expect(compositeTrend(80, null)).toBeNull();
    expect(compositeTrend(80, undefined)).toBeNull();
    expect(compositeTrend(80, 72)).toBe(8);
    expect(compositeTrend(60, 75)).toBe(-15);
  });
});
