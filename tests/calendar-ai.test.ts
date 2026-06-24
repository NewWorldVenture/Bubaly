import { describe, expect, it } from 'vitest';
import {
  analyzeCalendarEvents,
  buildCalendarPrompt,
  parseCalendarResponse,
  type CalendarEventLike,
} from '@/lib/calendar/calendar-ai';

function event(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return { title: 'Meeting', category: 'general', starts_at: '2026-07-01T10:00:00Z', all_day: false, ...overrides };
}

describe('analyzeCalendarEvents', () => {
  it('summarizes events', () => {
    const r = analyzeCalendarEvents([
      event({ category: 'general' }),
      event({ title: 'Soccer', category: 'sports' }),
      event({ title: 'Dentist', category: 'appointment' }),
    ]);
    expect(r.totalEvents).toBe(3);
    expect(r.categoryCounts['general']).toBe(1);
    expect(r.categoryCounts['sports']).toBe(1);
    expect(r.summary).toContain('3 events');
  });

  it('identifies busiest day', () => {
    const r = analyzeCalendarEvents([
      event({ starts_at: '2026-07-01T10:00:00Z' }),
      event({ starts_at: '2026-07-01T14:00:00Z' }),
      event({ starts_at: '2026-07-02T10:00:00Z' }),
    ]);
    expect(r.busiestDay).toBe('2026-07-01');
  });

  it('counts upcoming events', () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const past = new Date();
    past.setDate(past.getDate() - 5);
    const r = analyzeCalendarEvents([
      event({ starts_at: future.toISOString() }),
      event({ starts_at: past.toISOString() }),
    ]);
    expect(r.upcomingCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeCalendarEvents([]);
    expect(r.totalEvents).toBe(0);
    expect(r.busiestDay).toBeNull();
  });
});

describe('buildCalendarPrompt', () => {
  it('builds prompt with event info', () => {
    const { system, user } = buildCalendarPrompt([event({ title: 'Team Standup' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Team Standup');
  });
});

describe('parseCalendarResponse', () => {
  it('parses valid JSON', () => {
    const r = parseCalendarResponse('{"suggestions":["block family time"],"conflictWarnings":["double booked"],"planningTip":"sync calendars"}');
    expect(r.suggestions).toEqual(['block family time']);
    expect(r.conflictWarnings).toEqual(['double booked']);
    expect(r.planningTip).toBe('sync calendars');
  });

  it('handles malformed input', () => {
    const r = parseCalendarResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseCalendarResponse('```json\n{"suggestions":["x"],"conflictWarnings":["y"],"planningTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
