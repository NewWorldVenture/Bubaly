import { describe, it, expect } from 'vitest';
import { projectActivity, type ActivityDecision, type SimContext } from '@/lib/twin/simulate';

function activity(o: Partial<ActivityDecision> = {}): ActivityDecision {
  return {
    memberName: 'Emma', activityName: 'Travel Soccer',
    startsAt: '2026-07-08T17:30:00.000Z', // Wed evening
    durationMin: 90, sessionsPerWeek: 3, weeks: 12,
    travelMinEach: 25, costCents: 40000, costCategory: 'activities',
    ...o,
  };
}
function ctx(o: Partial<SimContext> = {}): SimContext {
  return { memberEvents: [], budgets: [{ category: 'activities', limitCents: 60000, spentCents: 10000 }], ...o };
}

describe('projectActivity', () => {
  it('projects every dimension for a rich activity', () => {
    const r = projectActivity(activity(), ctx());
    const keys = new Set(r.dimensions.map((d) => d.key));
    expect(keys.has('schedule')).toBe(true);
    expect(keys.has('travel')).toBe(true);
    expect(keys.has('cost')).toBe(true);
    expect(keys.has('family_time')).toBe(true);
    // Wed 17:30 → school night + dinner overlap.
    expect(keys.has('homework')).toBe(true);
    expect(keys.has('meals')).toBe(true);
    // weeklyHours = 3 × (90 + 50) / 60 = 7h.
    expect(r.weeklyHours).toBe(7);
  });

  it('flags a hard schedule conflict as a blocker verdict', () => {
    const r = projectActivity(activity(), ctx({
      memberEvents: [{ id: 'e1', title: 'Piano', startsAt: '2026-07-08T17:45:00.000Z', endsAt: '2026-07-08T18:30:00.000Z', allDay: false }],
    }));
    const sched = r.dimensions.find((d) => d.key === 'schedule')!;
    expect(sched.severity).toBe('blocker');
    expect(r.verdict).toBe('conflict');
  });

  it('flags an over-budget cost as a blocker', () => {
    const r = projectActivity(activity({ costCents: 90000 }), ctx()); // 90k vs 50k headroom
    const cost = r.dimensions.find((d) => d.key === 'cost')!;
    expect(cost.severity).toBe('blocker');
  });

  it('flags heavy travel and heavy weekly hours', () => {
    const r = projectActivity(activity({ travelMinEach: 60, sessionsPerWeek: 3, durationMin: 120 }), ctx());
    const travel = r.dimensions.find((d) => d.key === 'travel')!;
    expect(travel.severity).not.toBe('ok'); // 3 × 120 min travel/week = 6h
    const ft = r.dimensions.find((d) => d.key === 'family_time')!;
    expect(ft.severity).toBe('blocker'); // 3 × (120+120)/60 = 12h/week
  });

  it('detects a vacation overlap', () => {
    const r = projectActivity(activity({ startsAt: '2026-07-08T10:00:00.000Z' }), ctx({
      vacationWindows: [{ start: '2026-07-14T00:00:00.000Z', end: '2026-07-21T00:00:00.000Z', label: 'Beach week' }],
    }));
    const vac = r.dimensions.find((d) => d.key === 'vacation');
    expect(vac).toBeTruthy();
    expect(vac!.headline).toContain('Beach week');
  });

  it('reads as clear for a light, well-timed, in-budget activity', () => {
    // Sat morning, 1×/week, short, no travel, cheap.
    const r = projectActivity({
      memberName: 'Leo', activityName: 'Chess Club', startsAt: '2026-07-11T10:00:00.000Z',
      durationMin: 60, sessionsPerWeek: 1, weeks: 8, travelMinEach: 0, costCents: 2000, costCategory: 'activities',
    }, ctx());
    expect(r.verdict).toBe('clear');
    expect(r.dimensions.find((d) => d.key === 'homework')).toBeUndefined(); // weekend
    expect(r.dimensions.find((d) => d.key === 'meals')).toBeUndefined();    // morning
  });

  it('handles an invalid start time without throwing', () => {
    const r = projectActivity(activity({ startsAt: 'nope' }), ctx());
    expect(r.verdict).toBe('conflict');
  });
});
