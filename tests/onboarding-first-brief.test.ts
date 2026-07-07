import { describe, it, expect } from 'vitest';
import { buildFirstBrief, briefSummary, type BriefEvent } from '@/lib/onboarding/first-brief';

const NOW = new Date('2026-07-07T12:00:00.000Z'); // a Tuesday

function ev(o: Partial<BriefEvent> & { start: string }): BriefEvent {
  return { title: 'Event', end: null, allDay: false, location: null, recurring: false, ...o };
}

describe('buildFirstBrief', () => {
  it('builds today’s timeline in order with all-day first', () => {
    const b = buildFirstBrief([
      ev({ title: 'Dentist', start: '2026-07-07T16:30:00.000Z' }),
      ev({ title: 'Standup', start: '2026-07-07T09:00:00.000Z', location: 'Home' }),
      ev({ title: 'Holiday', start: '2026-07-07T00:00:00.000Z', allDay: true }),
      ev({ title: 'Tomorrow thing', start: '2026-07-08T09:00:00.000Z' }),
    ], NOW);
    expect(b.timeline.map((t) => t.title)).toEqual(['Holiday', 'Standup', 'Dentist']);
    expect(b.timeline[0].timeLabel).toBe('All day');
    expect(b.timeline[1].timeLabel).toBe('9:00 AM');
    expect(b.todayCount).toBe(3);
  });

  it('detects overlapping same-day events as conflicts', () => {
    const b = buildFirstBrief([
      ev({ title: 'Soccer', start: '2026-07-07T16:00:00.000Z', end: '2026-07-07T17:30:00.000Z' }),
      ev({ title: 'Dentist', start: '2026-07-07T16:30:00.000Z', end: '2026-07-07T17:15:00.000Z' }),
      ev({ title: 'Dinner', start: '2026-07-07T18:30:00.000Z', end: '2026-07-07T19:30:00.000Z' }),
    ], NOW);
    expect(b.conflicts).toHaveLength(1);
    expect(new Set([b.conflicts[0].aTitle, b.conflicts[0].bTitle])).toEqual(new Set(['Soccer', 'Dentist']));
    expect(b.conflicts[0].dayLabel).toBe('Today');
    // The clash surfaces as the top-priority action.
    expect(b.actions[0].kind).toBe('conflict');
  });

  it('does not flag back-to-back (non-overlapping) events as a conflict', () => {
    const b = buildFirstBrief([
      ev({ title: 'A', start: '2026-07-07T16:00:00.000Z', end: '2026-07-07T17:00:00.000Z' }),
      ev({ title: 'B', start: '2026-07-07T17:00:00.000Z', end: '2026-07-07T18:00:00.000Z' }),
    ], NOW);
    expect(b.conflicts).toHaveLength(0);
  });

  it('surfaces a missing-location action for today/tomorrow events', () => {
    const b = buildFirstBrief([
      ev({ title: 'Recital', start: '2026-07-08T18:00:00.000Z', location: null }),
    ], NOW);
    const loc = b.actions.find((a) => a.kind === 'location');
    expect(loc).toBeTruthy();
    expect(loc!.detail).toContain('Recital');
  });

  it('computes time-saved opportunities and totals them', () => {
    const b = buildFirstBrief([
      ev({ title: 'Soccer', start: '2026-07-07T16:00:00.000Z', end: '2026-07-07T17:30:00.000Z', recurring: true }),
      ev({ title: 'Dentist', start: '2026-07-07T16:30:00.000Z', end: '2026-07-07T17:15:00.000Z' }),
      ev({ title: 'Piano', start: '2026-07-08T15:30:00.000Z', recurring: true }),
    ], NOW);
    expect(b.opportunities.length).toBeGreaterThan(0);
    expect(b.opportunities.length).toBeLessThanOrEqual(3);
    expect(b.timeSavedMinutes).toBe(b.opportunities.reduce((s, o) => s + o.minutes, 0));
    expect(b.timeSavedMinutes).toBeGreaterThan(0);
  });

  it('returns a calm, valid brief for an empty import (no crash)', () => {
    const b = buildFirstBrief([], NOW);
    expect(b.timeline).toEqual([]);
    expect(b.conflicts).toEqual([]);
    expect(b.timeSavedMinutes).toBe(0);
    expect(b.headline).toMatch(/set up/i);
  });

  it('ignores malformed events instead of throwing', () => {
    const b = buildFirstBrief([
      ev({ title: 'Good', start: '2026-07-07T09:00:00.000Z' }),
      { title: 'Bad', start: 'not-a-date' } as BriefEvent,
    ], NOW);
    expect(b.todayCount).toBe(1);
  });

  it('names the day in the headline', () => {
    const b = buildFirstBrief([ev({ title: 'X', start: '2026-07-07T09:00:00.000Z' })], NOW);
    expect(b.headline).toContain('Tuesday');
  });
});

describe('briefSummary', () => {
  it('produces a compact JSON summary for persistence', () => {
    const b = buildFirstBrief([
      ev({ title: 'Soccer', start: '2026-07-07T16:00:00.000Z', end: '2026-07-07T17:30:00.000Z', recurring: true }),
      ev({ title: 'Dentist', start: '2026-07-07T16:30:00.000Z', end: '2026-07-07T17:15:00.000Z' }),
    ], NOW);
    const s = briefSummary(b);
    expect(s.conflictCount).toBe(1);
    expect(s.todayCount).toBe(2);
    expect(typeof s.timeSavedMinutes).toBe('number');
    expect(Array.isArray(s.opportunities)).toBe(true);
  });
});
