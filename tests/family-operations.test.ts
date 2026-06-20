import { describe, expect, it } from 'vitest';
import { completionScore, nextBestActions, type OpsSnapshot, type ActionInputs } from '@/lib/family/operations';

const empty: OpsSnapshot = {
  choresDone: 0, choresTotal: 0, billsPaid: 0, billsTotal: 0,
  homeworkDone: 0, homeworkTotal: 0, routinesOnTrack: 0, routinesTotal: 0,
};

describe('completionScore', () => {
  it('treats an empty household as fully on top of things', () => {
    expect(completionScore(empty)).toBe(100);
  });

  it('ignores dimensions with nothing to track', () => {
    // Only chores tracked, all done → 100 even though other dims are 0/0.
    expect(completionScore({ ...empty, choresDone: 4, choresTotal: 4 })).toBe(100);
  });

  it('weights chores most heavily', () => {
    const choresHalf = completionScore({ ...empty, choresDone: 1, choresTotal: 2 });
    expect(choresHalf).toBe(50);
  });

  it('blends multiple dimensions by weight', () => {
    const s = completionScore({
      ...empty, choresDone: 2, choresTotal: 4, billsPaid: 1, billsTotal: 1,
    });
    // chores .5*0.4 + bills 1*0.25 = .45 over weight .65 ≈ 69
    expect(s).toBe(69);
  });
});

const base: ActionInputs = {
  overdueTasks: 0, dueTodayTasks: 0, overdueBills: 0, billsDueSoon: 0,
  appointmentsToday: 0, homeworkDueSoon: 0, stressLevel: 'low',
  emptyGrocery: false, plannedMeals: 0,
};

describe('nextBestActions', () => {
  it('returns nothing for a clear day', () => {
    expect(nextBestActions(base)).toHaveLength(0);
  });

  it('puts overdue bills at the top as high priority', () => {
    const actions = nextBestActions({ ...base, overdueBills: 2, dueTodayTasks: 1 });
    expect(actions[0].id).toBe('overdue-bills');
    expect(actions[0].priority).toBe('high');
    expect(actions[0].href).toBe('/dashboard/family-cfo');
  });

  it('orders high-priority actions before medium/low', () => {
    const actions = nextBestActions({
      ...base, overdueTasks: 1, homeworkDueSoon: 1, plannedMeals: 2, emptyGrocery: true,
    });
    const priorities = actions.map((a) => a.priority);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    expect(priorities.map((p) => rank[p])).toEqual([...priorities.map((p) => rank[p])].sort());
  });

  it('only suggests groceries when meals are planned but the list is empty', () => {
    expect(nextBestActions({ ...base, plannedMeals: 3, emptyGrocery: true }).some((a) => a.id === 'grocery')).toBe(true);
    expect(nextBestActions({ ...base, plannedMeals: 0, emptyGrocery: true }).some((a) => a.id === 'grocery')).toBe(false);
  });
});
