import { describe, expect, it } from 'vitest';
import {
  googleEventToRow, rowToGoogleEvent, eventContentHash,
  googleTaskToReminderRow, reminderRowToGoogleTask, reminderContentHash,
  type GEvent, type GTask,
} from '@/lib/sync/providers/google';

describe('Google event mapping', () => {
  it('maps a timed event', () => {
    const ev: GEvent = {
      id: 'g1', iCalUID: 'g1@google.com', status: 'confirmed', summary: 'Standup',
      description: 'daily', location: 'Zoom',
      start: { dateTime: '2026-06-21T09:00:00Z' }, end: { dateTime: '2026-06-21T09:30:00Z' },
      etag: '"abc"',
    };
    const row = googleEventToRow(ev)!;
    expect(row.external_id).toBe('g1');
    expect(row.uid).toBe('g1@google.com');
    expect(row.title).toBe('Standup');
    expect(row.all_day).toBe(false);
    expect(row.starts_at).toBe('2026-06-21T09:00:00.000Z');
    expect(row.cancelled).toBe(false);
  });

  it('maps an all-day event from date fields', () => {
    const ev: GEvent = { id: 'g2', summary: 'Holiday', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } };
    const row = googleEventToRow(ev)!;
    expect(row.all_day).toBe(true);
    expect(row.starts_at.slice(0, 10)).toBe('2026-12-25');
  });

  it('extracts RRULE without the prefix', () => {
    const ev: GEvent = { id: 'g3', summary: 'Weekly', start: { dateTime: '2026-06-21T09:00:00Z' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] };
    expect(googleEventToRow(ev)!.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('flags cancelled events', () => {
    const ev: GEvent = { id: 'g4', status: 'cancelled', start: { dateTime: '2026-06-21T09:00:00Z' } };
    expect(googleEventToRow(ev)!.cancelled).toBe(true);
  });

  it('returns null when there is no usable start', () => {
    expect(googleEventToRow({ id: 'g5', summary: 'x' })).toBeNull();
  });

  it('builds a Google body for a timed event', () => {
    const body = rowToGoogleEvent({ title: 'Meet', starts_at: '2026-06-21T09:00:00Z', ends_at: '2026-06-21T10:00:00Z', timezone: 'America/New_York' });
    expect(body.summary).toBe('Meet');
    expect((body.start as { dateTime: string }).dateTime).toBe('2026-06-21T09:00:00.000Z');
    expect((body.start as { timeZone: string }).timeZone).toBe('America/New_York');
  });

  it('builds a Google body for an all-day event using date keys', () => {
    const body = rowToGoogleEvent({ title: 'Trip', starts_at: '2026-07-01T00:00:00Z', ends_at: '2026-07-05T00:00:00Z', all_day: true });
    expect((body.start as { date: string }).date).toBe('2026-07-01');
    expect((body.end as { date: string }).date).toBe('2026-07-05');
  });

  it('event content hash is stable and sensitive to changes', () => {
    const base = { title: 'A', starts_at: '2026-06-21T09:00:00Z' };
    expect(eventContentHash(base)).toBe(eventContentHash({ ...base }));
    expect(eventContentHash(base)).not.toBe(eventContentHash({ ...base, title: 'B' }));
  });
});

describe('Google task mapping', () => {
  it('maps a task to a reminder row', () => {
    const t: GTask = { id: 't1', title: 'Buy milk', notes: '2%', due: '2026-06-22T00:00:00Z', status: 'needsAction' };
    const row = googleTaskToReminderRow(t);
    expect(row.external_id).toBe('t1');
    expect(row.title).toBe('Buy milk');
    expect(row.is_completed).toBe(false);
    expect(row.due_at).toBe('2026-06-22T00:00:00.000Z');
  });

  it('maps completion', () => {
    const t: GTask = { id: 't2', title: 'Done', status: 'completed', completed: '2026-06-20T12:00:00Z' };
    const row = googleTaskToReminderRow(t);
    expect(row.is_completed).toBe(true);
    expect(row.completed_at).toBe('2026-06-20T12:00:00.000Z');
  });

  it('flags deleted tasks', () => {
    expect(googleTaskToReminderRow({ id: 't3', deleted: true }).deleted).toBe(true);
  });

  it('builds a Google task body with status', () => {
    expect(reminderRowToGoogleTask({ title: 'X', is_completed: true }).status).toBe('completed');
    expect(reminderRowToGoogleTask({ title: 'X', is_completed: false }).status).toBe('needsAction');
  });

  it('reminder content hash reacts to completion', () => {
    const base = { title: 'A', is_completed: false };
    expect(reminderContentHash(base)).not.toBe(reminderContentHash({ ...base, is_completed: true }));
  });
});
