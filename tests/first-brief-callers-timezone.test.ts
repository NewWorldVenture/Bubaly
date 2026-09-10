import { describe, expect, it } from 'vitest';
import { buildBrief, type BriefInput } from '@/lib/briefing/build';
import { buildHomeBrief, type HomeBriefInput } from '@/lib/home/home-brief';
import type { BriefEvent } from '@/lib/onboarding/first-brief';
import type { DinnerIdea } from '@/lib/onboarding/dinner-ideas';

const dinners: DinnerIdea[] = ['quick', 'standard', 'involved'].map(effort => ({
  title: `${effort} dinner`, effort: effort as DinnerIdea['effort'], cuisine: 'Family recipe', prepMinutes: 20, description: null,
}));
const event = (title: string, start: string, end?: string): BriefEvent => ({ title, start, end });
const input = (now: string, events: BriefEvent[] = []): BriefInput => ({ kind: 'daily', now: new Date(now), events, snapshot: {}, completedRuns: [], activity: [], dinnerCandidates: dinners });
const home = (timezone: string, upcomingEvents: BriefEvent[] = []): HomeBriefInput & { timezone: string } => ({
  timezone, upcomingEvents, dinnerCandidates: dinners, choresPending: 0, openTodos: 0, groceryOpen: 0, memberCount: 1,
});

describe('brief callers use the authoritative family timezone', () => {
  it('keeps the briefing date, timeline and conflict on the same local evening across UTC midnight', () => {
    const source = input('2026-09-10T00:00:00Z', [
      event('Practice', '2026-09-09T23:30:00Z', '2026-09-10T01:00:00Z'),
      event('Appointment', '2026-09-10T00:15:00Z', '2026-09-10T01:30:00Z'),
      event('Tomorrow', '2026-09-10T05:00:00Z'),
    ]);
    const before = structuredClone(source);
    const brief = buildBrief(source, 'America/New_York');
    expect(brief.asOfDate).toBe('2026-09-09');
    expect(brief.calendar.timeline.map(row => [row.title, row.timeLabel])).toEqual([['Practice', '7:30 PM'], ['Appointment', '8:15 PM']]);
    expect(brief.counts.today).toBe(2);
    expect(brief.calendar.conflicts).toEqual([{ aTitle: 'Practice', bTitle: 'Appointment', dayLabel: 'Today', overlapLabel: '8:15 PM–9:00 PM' }]);
    expect(source).toEqual(before);
  });

  it('keeps original all-day calendar dates when the family is still on yesterday’s UTC date', () => {
    const brief = buildBrief(input('2026-09-10T02:00:00Z', [
      { ...event('School closed', '2026-09-09T00:00:00Z'), allDay: true },
      { ...event('Next holiday', '2026-09-10T00:00:00Z'), allDay: true },
    ]), 'America/Los_Angeles');
    expect(brief.asOfDate).toBe('2026-09-09');
    expect(brief.calendar.timeline.map(row => [row.title, row.timeLabel])).toEqual([['School closed', 'All day']]);
  });

  it('keeps tomorrow’s conflict on the next calendar day through spring DST', () => {
    const brief = buildBrief(input('2026-03-07T23:30:00-05:00', [
      event('Practice', '2026-03-08T22:00:00-04:00', '2026-03-08T23:00:00-04:00'),
      event('Meeting', '2026-03-08T22:30:00-04:00', '2026-03-08T23:30:00-04:00'),
    ]), 'America/New_York');
    expect(brief.asOfDate).toBe('2026-03-07');
    expect(brief.calendar.conflicts[0]).toMatchObject({ dayLabel: 'Tomorrow', overlapLabel: '10:30 PM–11:00 PM' });
  });

  it('formats the two repeated fall-DST hours as the family sees them', () => {
    const brief = buildBrief(input('2026-11-01T00:30:00-04:00', [
      event('Early', '2026-11-01T01:15:00-04:00'), event('Late', '2026-11-01T01:15:00-05:00'),
      event('Monday', '2026-11-02T00:30:00-05:00'),
    ]), 'America/New_York');
    expect(brief.calendar.timeline.map(row => [row.title, row.timeLabel])).toEqual([['Early', '1:15 AM'], ['Late', '1:15 AM']]);
    expect(brief.calendar.actions.find(action => action.id.startsWith('location:Monday'))?.detail).toContain('tomorrow');
  });

  it('home finds an actual overlap whose starts fall on different UTC dates', () => {
    const source = home('America/New_York', [
      event('Practice', '2026-09-09T23:30:00Z', '2026-09-10T01:00:00Z'),
      event('Appointment', '2026-09-10T00:15:00Z', '2026-09-10T01:30:00Z'),
    ]);
    source.groceryOpen = 1;
    const brief = buildHomeBrief(source, new Date('2026-09-10T00:00:00Z'));
    expect(brief.conflictCount).toBe(1);
    expect(brief.headline).toContain('1 clash');
    expect(brief.weekCount).toBe(2);
    expect(brief.steps.find(step => step.id === 'grocery')?.done).toBe(true);
  });

  it('home uses the family’s Sunday meal preference after UTC has entered Monday', () => {
    const now = new Date('2026-09-07T01:00:00Z');
    expect(buildHomeBrief(home('America/New_York'), now).dinnerIdeas[0].effort).toBe('involved');
    expect(buildHomeBrief(home('UTC'), now).dinnerIdeas[0].effort).toBe('standard');
    const { timezone: _timezone, ...legacy } = home('UTC');
    expect(buildHomeBrief(legacy, now)).toEqual(buildHomeBrief(home('UTC'), now));
  });

  it('does not silently fabricate a UTC brief for a malformed supplied family zone', () => {
    expect(() => buildBrief(input('2026-09-10T00:00:00Z'), 'Invalid/Zone')).toThrow(RangeError);
    expect(() => buildHomeBrief(home('Invalid/Zone'), new Date('2026-09-10T00:00:00Z'))).toThrow(RangeError);
  });
});
