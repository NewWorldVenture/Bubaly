import { describe, expect, it } from 'vitest';
import { buildFirstBrief, briefSummary, type BriefEvent, type FirstBrief } from '@/lib/onboarding/first-brief';
import { buildBrief } from '@/lib/briefing/build';
import { buildHomeBrief } from '@/lib/home/home-brief';

// Count seven family calendar dates without extending the timed-event value model.
function event(title: string, start: string, end = start): BriefEvent {
  return { title, start, end, location: 'Already supplied', recurring: false };
}
function inspect(_scenario: string, events: BriefEvent[], now: string, timezone = 'UTC'): FirstBrief {
  const before = structuredClone(events);
  const brief = buildFirstBrief(events, new Date(now), [], timezone);
  expect(events).toEqual(before);
  return brief;
}
function wrapper(events: BriefEvent[], now: string, timezone = 'UTC') {
  return buildBrief({ kind: 'daily', now: new Date(now), events, snapshot: {}, completedRuns: [], activity: [] }, timezone);
}
const allDay = (title: string, day: string): BriefEvent => ({ ...event(title, day + 'T00:00:00.000Z'), end: null, allDay: true, location: null, recurring: true });
const mixed = [allDay('School holiday', '2026-09-10'), event('Appointment', '2026-09-10T13:00:00Z')];
const yesterday = [
  { ...event('Yesterday A', '2026-09-09T18:00:00Z', '2026-09-09T19:00:00Z'), recurring: true },
  { ...event('Yesterday B', '2026-09-09T18:30:00Z', '2026-09-09T19:30:00Z'), recurring: true },
];
const fall = [
  event('Early today A', '2026-11-01T00:15:00-04:00', '2026-11-01T01:15:00-04:00'),
  event('Early today B', '2026-11-01T00:45:00-04:00', '2026-11-01T01:30:00-04:00'),
];

describe('FirstBrief counted calendar week', () => {
  it('counts an all-day item alongside the timed item already listed today', () => {
    const brief = inspect('mixed all-day counted', mixed, '2026-09-10T16:00:00Z', 'America/New_York');
    expect(brief.todayCount).toBe(2);
    expect(brief.weekCount).toBe(2);
  });
  it('uses all counted events in organized display facts without awarding all-day minutes', () => {
    const brief = inspect('organized all-day display', mixed, '2026-09-10T16:00:00Z', 'America/New_York');
    expect(brief.opportunities.find(item => item.id === 'week')).toMatchObject({ detail: '2 events sorted into one shared timeline.', minutes: 2, display: { kind: 'week', count: 2 } });
  });
  it('does not call a future all-day-only import empty', () => {
    const brief = inspect('future all-day only', [allDay('Tomorrow holiday', '2026-09-11')], '2026-09-10T16:00:00Z', 'America/New_York');
    expect(brief.weekCount).toBe(1);
    expect(brief.display?.headline).not.toBe('empty');
    expect(brief.opportunities.find(item => item.id === 'week')).toMatchObject({ minutes: 0, display: { kind: 'week', count: 1 } });
  });
  it.each(['America/Los_Angeles', 'Asia/Tokyo'])('retains original all-day date identity for the seventh day in %s', timezone => {
    const brief = inspect('all-day original date ' + timezone, [allDay('Seventh day', '2026-09-16'), allDay('Eighth day', '2026-09-17')], '2026-09-10T12:00:00Z', timezone);
    expect(brief.weekCount).toBe(1);
  });
  it('excludes yesterday from the organized count, clashes, actions and estimated minutes', () => {
    const brief = inspect('yesterday leakage', yesterday, '2026-09-10T12:00:00Z');
    expect.soft(brief.weekCount).toBe(0);
    expect.soft(brief.conflicts).toEqual([]);
    expect.soft(brief.actions).toEqual([]);
    expect.soft(brief.timeSavedMinutes).toBe(0);
  });
  it('includes the complete seventh date regardless of current clock time', () => {
    const brief = inspect('complete seventh date', [event('End of seventh date', '2026-09-16T23:59:59.999Z')], '2026-09-10T00:00:00Z');
    expect(brief.weekCount).toBe(1);
  });
  it('excludes the eighth date at midnight instead of cutting it off at the current clock time', () => {
    const brief = inspect('eighth date midnight', [event('Eighth date', '2026-09-17T00:00:00Z')], '2026-09-10T12:00:00Z');
    expect(brief.weekCount).toBe(0);
  });
  it('uses family calendar dates at the upper boundary ahead of UTC', () => {
    const brief = inspect('Tokyo eighth date', [event('Next Thursday', '2026-09-17T00:00:00+09:00')], '2026-09-09T22:30:00Z', 'Asia/Tokyo');
    expect(brief.weekCount).toBe(0);
  });
  it('does not reach a ninth calendar date when the elapsed endpoint crosses spring DST', () => {
    const brief = inspect('spring DST ninth date', [event('Outside next seven dates', '2026-03-09T00:15:00-04:00')], '2026-03-01T23:30:00-05:00', 'America/New_York');
    expect(brief.weekCount).toBe(0);
  });
  it('keeps early-today events and their actual clash late on the long fall-DST day', () => {
    const brief = inspect('fall DST early today', fall, '2026-11-01T23:30:00-05:00', 'America/New_York');
    expect(brief.todayCount).toBe(2);
    expect.soft(brief.weekCount).toBe(2);
    expect.soft(brief.conflicts).toHaveLength(1);
    expect.soft(brief.timeSavedMinutes).toBe(19);
  });
});

describe('actual wrapper propagation of the calendar week', () => {
  it('propagates all-day week count into daily envelope and canonical compact summary', () => {
    const brief = wrapper(mixed, '2026-09-10T16:00:00Z', 'America/New_York');
    expect.soft(brief.counts.week).toBe(2);
    expect.soft(briefSummary(brief.calendar).weekCount).toBe(2);
    expect(brief.counts.today).toBe(2);
  });
  it('does not propagate yesterday clashes or estimates through buildBrief', () => {
    const brief = wrapper(yesterday, '2026-09-10T12:00:00Z');
    expect.soft(brief.counts).toMatchObject({ week: 0, conflicts: 0, timeSavedMinutes: 0 });
    expect.soft(brief.calendar.actions).toEqual([]);
  });
  it('restores a same-local-day clash through buildBrief late on fall DST', () => {
    const brief = wrapper(fall, '2026-11-01T23:30:00-05:00', 'America/New_York');
    expect(brief.counts).toMatchObject({ today: 2, week: 2, conflicts: 1, timeSavedMinutes: 19 });
  });
  it('removes past-only conflicts from Home without redefining its caller-supplied event count', () => {
    const brief = buildHomeBrief({ timezone: 'UTC', upcomingEvents: yesterday, dinnerCandidates: [], choresPending: 0, openTodos: 0, groceryOpen: 0, memberCount: 1 }, new Date('2026-09-10T12:00:00Z'));
    expect(brief.weekCount).toBe(2); // Home owns a separate raw-row count; intentionally outside proposed scope.
    expect.soft(brief.conflictCount).toBe(0);
    expect.soft(brief.timeSavedMinutes).toBe(0);
  });
});

describe('calendar-week scope preservation controls', () => {
  it('keeps all-day additions out of timed clashes, location/recurrence opportunities and minutes', () => {
    const timed = [event('Timed', '2026-09-10T13:00:00Z')];
    const baseline = inspect('timed model baseline', timed, '2026-09-10T16:00:00Z');
    const withAllDay = inspect('all-day model eligibility unchanged', [...timed, allDay('Holiday', '2026-09-10')], '2026-09-10T16:00:00Z');
    expect(withAllDay.conflicts).toEqual(baseline.conflicts);
    const canonicalActions = (brief: FirstBrief) => brief.actions.map(({ display: _display, ...action }) => action);
    expect(canonicalActions(withAllDay)).toEqual(canonicalActions(baseline));
    expect(withAllDay.opportunities.find(item => item.id === 'recurring')).toBeUndefined();
    expect(withAllDay.timeSavedMinutes).toBe(baseline.timeSavedMinutes);
  });
  it('retains explicit UTC default and ignores invalid event starts', () => {
    const events = [event('Current', '2026-09-10T00:00:00Z'), event('Invalid', 'bad')];
    const implicit = buildFirstBrief(events, new Date('2026-09-10T12:00:00Z'));
    expect(implicit).toEqual(buildFirstBrief(events, new Date('2026-09-10T12:00:00Z'), [], 'UTC'));
    expect(implicit.todayCount).toBe(1);
  });
  it('preserves point-event nonconflict semantics within the new date horizon', () => {
    const brief = inspect('explicit point unchanged', [event('Point', '2026-09-10T13:00:00Z'), event('Meeting', '2026-09-10T12:30:00Z', '2026-09-10T13:30:00Z')], '2026-09-10T12:00:00Z');
    expect(brief.weekCount).toBe(2); expect(brief.conflicts).toEqual([]);
  });
});

