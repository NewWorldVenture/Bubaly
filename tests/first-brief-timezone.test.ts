import { describe, expect, it } from 'vitest';
import { buildFirstBrief, type BriefEvent } from '@/lib/onboarding/first-brief';
import type { DinnerIdea } from '@/lib/onboarding/dinner-ideas';

const event = (title: string, start: string, end?: string): BriefEvent => ({ title, start, end });
describe('first brief in the household timezone', () => {
  it('keeps evening events on the local day across UTC midnight, including conflicts', () => {
    const brief = buildFirstBrief([
      event('Practice', '2026-09-09T23:30:00Z', '2026-09-10T01:00:00Z'),
      event('Appointment', '2026-09-10T00:15:00Z', '2026-09-10T01:30:00Z'),
      event('Tomorrow', '2026-09-10T05:00:00Z'),
    ], new Date('2026-09-10T00:00:00Z'), [], 'America/New_York');
    expect(brief.todayCount).toBe(2);
    expect(brief.timeline.map((row) => row.timeLabel)).toEqual(['7:30 PM', '8:15 PM']);
    expect(brief.headline).toContain('Wednesday');
    expect(brief.conflicts).toEqual([{ aTitle: 'Practice', bTitle: 'Appointment', dayLabel: 'Today', overlapLabel: '8:15 PM–9:00 PM' }]);
    expect(brief.actions.find((action) => action.id.startsWith('location:Tomorrow'))?.detail).toContain('tomorrow');
  });
  it('honors explicit offsets and a household ahead of UTC', () => {
    const brief = buildFirstBrief([
      event('Morning', '2026-09-10T08:00:00+09:00'),
      event('Previous day', '2026-09-09T23:00:00+09:00'),
    ], new Date('2026-09-09T22:30:00Z'), [], 'Asia/Tokyo');
    expect(brief.timeline.map((row) => [row.title, row.timeLabel])).toEqual([['Morning', '8:00 AM']]);
    expect(brief.headline).toContain('Thursday');
  });
  it('preserves all-day calendar dates instead of shifting UTC midnight into yesterday', () => {
    const brief = buildFirstBrief([
      { ...event('School closed', '2026-09-09T00:00:00Z'), allDay: true },
      { ...event('Next holiday', '2026-09-10T00:00:00Z'), allDay: true },
    ], new Date('2026-09-09T15:00:00Z'), [], 'America/Los_Angeles');
    expect(brief.timeline.map((row) => [row.title, row.timeLabel])).toEqual([['School closed', 'All day']]);
  });
  it('labels tomorrow by calendar date across the short spring-forward day', () => {
    const brief = buildFirstBrief([
      event('Tomorrow practice', '2026-03-08T22:00:00-04:00', '2026-03-08T23:00:00-04:00'),
      event('Tomorrow meeting', '2026-03-08T22:30:00-04:00', '2026-03-08T23:30:00-04:00'),
    ], new Date('2026-03-07T23:30:00-05:00'), [], 'America/New_York');
    expect(brief.todayCount).toBe(0);
    expect(brief.conflicts[0]).toMatchObject({ dayLabel: 'Tomorrow', overlapLabel: '10:30 PM–11:00 PM' });
    expect(brief.actions.some((action) => action.detail.includes('tomorrow has no place'))).toBe(true);
  });
  it('labels tomorrow across the long fall-back day and formats both clock offsets', () => {
    const brief = buildFirstBrief([
      event('Early', '2026-11-01T01:15:00-04:00'),
      event('Late', '2026-11-01T01:15:00-05:00'),
      event('Monday', '2026-11-02T00:30:00-05:00'),
    ], new Date('2026-11-01T00:30:00-04:00'), [], 'America/New_York');
    expect(brief.timeline.map((row) => [row.title, row.timeLabel])).toEqual([['Early', '1:15 AM'], ['Late', '1:15 AM']]);
    expect(brief.actions.find((action) => action.id.startsWith('location:Monday'))?.detail).toContain('tomorrow');
  });
  it('chooses the local weekend meal preference and keeps UTC the default', () => {
    const dinners: DinnerIdea[] = ['quick', 'standard', 'involved'].map((effort) => ({ title: effort, effort: effort as DinnerIdea['effort'], cuisine: 'test', prepMinutes: 20, description: null }));
    const now = new Date('2026-09-07T01:00:00Z');
    expect(buildFirstBrief([], now, dinners, 'America/New_York').dinnerIdeas[0].effort).toBe('involved');
    expect(buildFirstBrief([], now, dinners).dinnerIdeas[0].effort).toBe('standard');
    expect(buildFirstBrief([], now, dinners)).toEqual(buildFirstBrief([], now, dinners, 'UTC'));
  });
  it('rejects an invalid household timezone rather than silently using another day', () => {
    expect(() => buildFirstBrief([], new Date('2026-09-09T12:00:00Z'), [], 'Invalid/Zone')).toThrow(RangeError);
  });
});
