import { describe, expect, it } from 'vitest';
import { buildFirstBrief, type BriefEvent } from '@/lib/onboarding/first-brief';

const now = new Date('2026-09-10T08:00:00Z');
const event = (title: string, start: string, end?: string): BriefEvent => ({
  title, start: `2026-09-10T${start}:00Z`,
  ...(end === undefined ? {} : { end: `2026-09-10T${end}:00Z` }),
  location: 'Office',
});

describe('explicit zero-duration calendar entries', () => {
  it.each(['09:00', '09:30', '10:00'])('keeps a %s point entry visible without inventing a clash', start => {
    const brief = buildFirstBrief([
      event('Appointment', '09:00', '10:00'), event('Point entry', start, start),
    ], now);
    expect(brief.todayCount).toBe(2);
    expect(brief.timeline.map(item => item.title)).toContain('Point entry');
    expect(brief.timeline.find(item => item.title === 'Point entry')).toMatchObject({
      start: `2026-09-10T${start}:00Z`, end: `2026-09-10T${start}:00Z`,
    });
    expect(brief.conflicts).toEqual([]);
    expect(brief.actions.some(action => action.kind === 'conflict')).toBe(false);
  });

  it('does not make simultaneous point entries conflict with each other', () => {
    const brief = buildFirstBrief([
      event('First point', '09:30', '09:30'), event('Second point', '09:30', '09:30'),
    ], now);
    expect(brief.todayCount).toBe(2);
    expect(brief.conflicts).toEqual([]);
    expect(brief.opportunities.some(item => item.id === 'conflicts')).toBe(false);
  });

  it('retains a real interval overlap alongside a point entry', () => {
    const brief = buildFirstBrief([
      event('First appointment', '09:00', '10:00'),
      event('Point entry', '09:45', '09:45'),
      event('Second appointment', '09:30', '10:30'),
    ], now);
    expect(brief.todayCount).toBe(3);
    expect(brief.conflicts).toHaveLength(1);
    expect(brief.conflicts[0]).toMatchObject({
      aTitle: 'First appointment', bTitle: 'Second appointment', overlapLabel: '9:30 AM–10:00 AM',
    });
    expect(brief.actions.filter(action => action.kind === 'conflict')).toHaveLength(1);
  });

  it('preserves the legacy one-hour estimate when no end was supplied', () => {
    const brief = buildFirstBrief([
      event('Unspecified duration', '09:00'), event('Appointment', '09:30', '10:00'),
    ], now);
    expect(brief.conflicts).toHaveLength(1);
    expect(brief.conflicts[0].overlapLabel).toBe('9:30 AM–10:00 AM');
    expect(brief.timeline[0].end).toBeNull();
  });
});
