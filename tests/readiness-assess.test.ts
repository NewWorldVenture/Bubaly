import { describe, it, expect } from 'vitest';
import {
  assessReadiness, overallReadiness, EMPTY_READINESS_SIGNALS, type ReadinessSignals,
} from '@/lib/readiness/assess';
import { calendarReadiness, type CalendarReadinessEvent } from '@/lib/readiness/calendar-source';

const sig = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({ ...EMPTY_READINESS_SIGNALS, ...over });

describe('assessReadiness', () => {
  it('returns three horizon cards', () => {
    const cards = assessReadiness(sig());
    expect(cards.map((c) => c.horizon)).toEqual(['tomorrow', 'week', 'month']);
  });

  it('is fully ready when everything is clear', () => {
    const cards = assessReadiness(sig());
    for (const c of cards) {
      expect(c.status).toBe('ready');
      expect(c.score).toBe(100);
      expect(c.gaps).toHaveLength(0);
    }
  });

  it('marks a horizon not_ready when a blocker exists', () => {
    const [tomorrow] = assessReadiness(sig({ tomorrowConflicts: 1 }));
    expect(tomorrow.status).toBe('not_ready');
    expect(tomorrow.gaps[0].severity).toBe('blocker');
    expect(tomorrow.score).toBe(65); // 100 - 35
  });

  it('marks a horizon at_risk when only watch-level gaps exist', () => {
    const [tomorrow] = assessReadiness(sig({ dinnerPlannedTomorrow: false, tomorrowUnassigned: 2 }));
    expect(tomorrow.status).toBe('at_risk');
    expect(tomorrow.score).toBe(70); // 100 - 2*15
  });

  it('orders blockers before watches', () => {
    const cards = assessReadiness(sig({ conflictsWeek: 1, billsDueWeek: 2 }));
    const week = cards.find((c) => c.horizon === 'week')!;
    expect(week.gaps[0].severity).toBe('blocker');
    expect(week.gaps[week.gaps.length - 1].severity).toBe('watch');
  });

  it('only flags unplanned dinners at 3+', () => {
    const week2 = assessReadiness(sig({ unplannedDinnersWeek: 2 })).find((c) => c.horizon === 'week')!;
    expect(week2.gaps.some((g) => g.label.includes('unplanned'))).toBe(false);
    const week3 = assessReadiness(sig({ unplannedDinnersWeek: 3 })).find((c) => c.horizon === 'week')!;
    expect(week3.gaps.some((g) => g.label.includes('unplanned'))).toBe(true);
  });

  it('surfaces expiring documents as a month blocker', () => {
    const month = assessReadiness(sig({ expiringDocsMonth: 1 })).find((c) => c.horizon === 'month')!;
    expect(month.status).toBe('not_ready');
    expect(month.gaps[0].href).toBe('/dashboard/documents');
  });

  it('clamps score at 0 for many gaps (2 blockers + 2 watches)', () => {
    const week = assessReadiness(sig({ conflictsWeek: 1, overduePrepSteps: 1, unplannedDinnersWeek: 3, billsDueWeek: 1 })).find((c) => c.horizon === 'week')!;
    expect(week.score).toBe(0); // 100 - 2*35 - 2*15 = 0
  });
});

describe('overallReadiness', () => {
  it('takes the weakest link', () => {
    const cards = assessReadiness(sig({ expiringDocsMonth: 1 }));
    const overall = overallReadiness(cards);
    expect(overall.status).toBe('not_ready');
    expect(overall.score).toBe(65); // month card dragged it down
  });

  it('is ready when all horizons are ready', () => {
    expect(overallReadiness(assessReadiness(sig()))).toEqual({ score: 100, status: 'ready' });
  });

  it('reports at_risk when the worst card is a watch', () => {
    const overall = overallReadiness(assessReadiness(sig({ billsDueWeek: 1 })));
    expect(overall.status).toBe('at_risk');
  });
});

const source = <T,>(data: T[], count: number | null = data.length) => ({ data, count, error: null });
const roster = source([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
const event = (index: number, assignee = 'one'): CalendarReadinessEvent => ({
  id: `event-${index}`, starts_at: new Date(Date.UTC(2026, 8, 6, 8 + index * 2)).toISOString(),
  ends_at: null, all_day: false, assignee_id: assignee,
});
const eight = Array.from({ length: 8 }, (_, index) => event(index));
const weeklyCards = (result: ReturnType<typeof calendarReadiness>) => assessReadiness(sig({
  conflictsWeek: result.conflicts, overloadedMembers: result.overloadedMembers,
  weekCalendarCoverage: result.calendarCoverage, workloadCoverage: result.workloadCoverage,
}));

describe('accessible calendar and roster coverage', () => {
  it('includes zero-event members in the relative 8/0/0 workload average', () => {
    const result = calendarReadiness(source(eight), roster);
    expect(result).toMatchObject({ conflicts: 0, overloadedMembers: 1, calendarCoverage: 'complete', workloadCoverage: 'complete' });
    expect(weeklyCards(result)[2].gaps.some((gap) => gap.label.includes('1 person carrying a heavy load'))).toBe(true);
  });

  it('distinguishes a genuinely all-zero known roster from missing coverage', () => {
    const result = calendarReadiness(source<CalendarReadinessEvent>([]), roster);
    expect(result.overloadedMembers).toBe(0);
    expect(overallReadiness(weeklyCards(result))).toEqual({ score: 100, status: 'ready' });
  });

  it('does not turn a failed calendar read into zero conflicts or healthy workload', () => {
    const result = calendarReadiness({ data: null, count: null, error: new Error('Unavailable') }, roster);
    expect(result).toMatchObject({ conflicts: null, unassigned: null, overloadedMembers: null, calendarCoverage: 'unknown' });
    const cards = weeklyCards(result);
    expect(cards[1].status).toBe('at_risk');
    expect(cards[2].status).toBe('at_risk');
    expect(cards[1].gaps[0].label).toContain('could not be read');
  });

  it('retains a known conflict as a lower bound when 200 returned rows are capped', () => {
    const rows = [event(0), { ...event(1), starts_at: event(0).starts_at },
      ...Array.from({ length: 198 }, (_, index) => ({ ...event(index + 2), all_day: true }))];
    const result = calendarReadiness(source(rows, 201), roster);
    expect(result).toMatchObject({ conflicts: 1, calendarCoverage: 'partial', overloadedMembers: null, workloadCoverage: 'partial' });
    const week = weeklyCards(result)[1];
    expect(week.status).toBe('not_ready');
    expect(week.gaps[0].label).toBe('At least 1 clash this week');
    expect(week.gaps.some((gap) => gap.label.includes('incomplete'))).toBe(true);
  });

  it('accepts an exact 200-row result rather than guessing every full page is truncated', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...event(index), all_day: true }));
    expect(calendarReadiness(source(rows), roster)).toMatchObject({ calendarCoverage: 'complete', workloadCoverage: 'complete', overloadedMembers: 0 });
  });

  it.each([null, 9, 7, -1])('does not certify incomplete or inconsistent exact counts: %s', (count) => {
    const result = calendarReadiness(source(eight, count), roster);
    expect(result.calendarCoverage).toBe('partial');
    expect(result.overloadedMembers).toBeNull();
    expect(overallReadiness(weeklyCards(result)).status).not.toBe('ready');
  });

  it('does not pad a partial household roster with assumed zero loads', () => {
    expect(calendarReadiness(source(eight), source([{ id: 'one' }], 3)))
      .toMatchObject({ conflicts: 0, calendarCoverage: 'complete', workloadCoverage: 'partial', overloadedMembers: null });
  });

  it('does not interpret a failed or empty accessible roster as healthy workload', () => {
    for (const members of [{ data: null, count: null, error: new Error('Denied') }, source<{ id: string }>([])]) {
      const result = calendarReadiness(source(eight), members);
      expect(result.workloadCoverage).toBe('unknown');
      expect(result.overloadedMembers).toBeNull();
      expect(weeklyCards(result)[2].status).toBe('at_risk');
    }
  });

  it('never invents or exposes inaccessible member identities from event assignees', () => {
    const result = calendarReadiness(source([...eight, event(9, 'private-member-id')]), roster);
    expect(result).toMatchObject({ calendarCoverage: 'complete', workloadCoverage: 'partial', overloadedMembers: null });
    expect(JSON.stringify(result)).not.toContain('private-member-id');
    expect(JSON.stringify(weeklyCards(result))).not.toContain('private-member-id');
  });

  it('does not count duplicate roster IDs as additional zero-load people', () => {
    expect(calendarReadiness(source(eight), source([{ id: 'one' }, { id: 'one' }])).workloadCoverage).toBe('partial');
  });

  it('keeps the shared one-hour overlap rule and excludes all-day events', () => {
    const rows = [event(0), { ...event(1), starts_at: '2026-09-06T08:30:00.000Z' }, { ...event(2), starts_at: event(0).starts_at, all_day: true }];
    expect(calendarReadiness(source(rows)).conflicts).toBe(1);
    expect(calendarReadiness(source(rows), roster).conflicts).toBe(1);
  });

  it('marks malformed timed rows incomplete without hiding a valid conflict', () => {
    const rows = [event(0), { ...event(1), starts_at: event(0).starts_at }, { ...event(2), starts_at: 'invalid' }];
    expect(calendarReadiness(source(rows), roster)).toMatchObject({ conflicts: 1, calendarCoverage: 'partial', overloadedMembers: null });
  });

  it('keeps unknown tomorrow coverage and null signals out of the ready state', () => {
    const cards = assessReadiness(sig({ tomorrowConflicts: null, tomorrowUnassigned: null, conflictsWeek: null, overloadedMembers: null }));
    expect(cards.every((card) => card.status === 'at_risk')).toBe(true);
  });
});
