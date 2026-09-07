// Putting an anniversary on the family calendar, and taking it off.
//
// The bug this closes is the pair coming apart. `toggleCalendar` deleted the
// event and then cleared `calendar_event_id` REGARDLESS — the delete's result
// was discarded — so a failed delete left the date saying "not on your calendar"
// while the event sat on it, with nothing linking them any more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn(),
  /** Overridden only where a DELETE has to fail for a reason that is not "already gone". */
  deleteEvent: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
// The real calendar service everywhere except the one case that needs a failing
// delete — the branch the old code got wrong and no in-memory row can produce.
vi.mock('@/lib/services/calendar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/calendar')>('@/lib/services/calendar');
  return { ...actual, deleteEvent: (...args: Parameters<typeof actual.deleteEvent>) => mocks.deleteEvent(...args) };
});

import { toggleDateOnCalendarAction } from '@/app/(app)/dashboard/relationship/actions';

const FAMILY = 'family-1';
const OTHER = 'family-2';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const events = (familyId = FAMILY) => db.table('calendar_events').filter((r) => r.family_id === familyId);
const theDate = () => db.table('relationship_dates').find((r) => r.id === 'date-1')!;

beforeEach(async () => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: { description: null, location: null, ends_at: null, all_day: false, category: 'general', recurrence: 'none', recurrence_until: null, assignee_id: null, idempotency_key: null },
      relationship_dates: { recurs_annually: false, location: null, notes: null, calendar_event_id: null, member_id: null, partner_name: null, reminder_days_before: 7, status: 'upcoming' },
    },
  });
  db.seed('relationship_dates', [{
    id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary',
    event_date: '2026-11-14', recurs_annually: true, location: 'The little Italian place',
  }]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
  // Default: the real implementation.
  const calendar = await vi.importActual<typeof import('@/lib/services/calendar')>('@/lib/services/calendar');
  mocks.deleteEvent.mockImplementation(calendar.deleteEvent);
});
afterEach(() => vi.restoreAllMocks());

describe('adding it to the calendar', () => {
  it('creates the event and links it, in one call', async () => {
    const result = await toggleDateOnCalendarAction('date-1');

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.onCalendar).toBe(true);
    expect(events()).toHaveLength(1);
    expect(theDate().calendar_event_id).toBe(events()[0]!.id);
  });

  it('keeps the domain rules the shared builder owns', async () => {
    await toggleDateOnCalendarAction('date-1');
    const event = events()[0]!;
    expect(event.title).toBe('Our anniversary');
    expect(event.all_day).toBe(true);
    // Noon UTC, so the day is stable across time zones.
    expect(event.starts_at).toBe('2026-11-14T12:00:00.000Z');
    // Recurring dates become yearly events.
    expect(event.recurrence).toBe('yearly');
    expect(event.location).toBe('The little Italian place');
  });

  it('files a birthday under the birthday category', async () => {
    db.table('relationship_dates')[0]!.kind = 'birthday';
    await toggleDateOnCalendarAction('date-1');
    expect(events()[0]!.category).toBe('birthday');
  });

  it('takes family_id and created_by from the session, not the browser', async () => {
    await toggleDateOnCalendarAction('date-1');
    expect(events()[0]!.family_id).toBe(FAMILY);
    expect(events()[0]!.created_by).toBe('user-1');
  });

  it('reads the date from the database rather than trusting what was sent', async () => {
    // Only an id crosses the wire, so the event says what the stored row says.
    db.table('relationship_dates')[0]!.title = 'Renamed since the page rendered';
    await toggleDateOnCalendarAction('date-1');
    expect(events()[0]!.title).toBe('Renamed since the page rendered');
  });
});

describe('taking it off the calendar', () => {
  it('removes the event and clears the link', async () => {
    const added = await toggleDateOnCalendarAction('date-1');
    expect(added.ok).toBe(true);

    const removed = await toggleDateOnCalendarAction('date-1');
    expect(removed.ok, removed.ok ? '' : removed.error).toBe(true);
    expect(removed.ok && removed.onCalendar).toBe(false);
    expect(events()).toHaveLength(0);
    expect(theDate().calendar_event_id).toBeNull();
  });

  it('KEEPS the link when the delete fails for a real reason', async () => {
    // THE bug. The old code discarded the delete's result and cleared the link
    // anyway, so a failed delete left the date saying "not on your calendar"
    // while the event sat on it, unreachable from either side.
    //
    // "Already gone" cannot stand in for this: a not-found delete is a dangling
    // link and clearing it is the repair (the next case). Only a real failure —
    // the database refusing — exercises this branch.
    const added = await toggleDateOnCalendarAction('date-1');
    expect(added.ok).toBe(true);
    const eventId = events()[0]!.id;

    mocks.deleteEvent.mockResolvedValueOnce({ ok: false, error: 'Could not remove that event.', code: 'db' });
    const result = await toggleDateOnCalendarAction('date-1');

    expect(result.ok).toBe(false);
    // The link survives, so the date still points at the event that still exists.
    expect(theDate().calendar_event_id).toBe(eventId);
  });

  it('clears a link into another household as already gone', async () => {
    // An event id this family cannot see or delete is, to them, gone — the
    // service's family filter answers not-found, and clearing the dangling link
    // is the same repair as the case below. Their event is untouched.
    db.seed('calendar_events', [{ id: 'theirs', family_id: OTHER, title: 'Not ours', starts_at: '2026-11-14T12:00:00.000Z' }]);
    db.table('relationship_dates')[0]!.calendar_event_id = 'theirs';

    const result = await toggleDateOnCalendarAction('date-1');

    expect(result.ok).toBe(true);
    expect(events(OTHER)).toHaveLength(1);
    expect(theDate().calendar_event_id).toBeNull();
  });

  it('clears a dangling link when the event is already gone', async () => {
    // Someone deleted the event from the calendar itself. Refusing here would
    // leave the family a toggle that can never be turned off.
    db.table('relationship_dates')[0]!.calendar_event_id = 'vanished';
    const result = await toggleDateOnCalendarAction('date-1');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(theDate().calendar_event_id).toBeNull();
  });
});

describe('another household’s date', () => {
  it('cannot be toggled', async () => {
    db.seed('relationship_dates', [{ id: 'theirs', family_id: OTHER, kind: 'anniversary', title: 'Theirs', event_date: '2026-12-01' }]);
    const result = await toggleDateOnCalendarAction('theirs');
    expect(result.ok).toBe(false);
    expect(events(OTHER)).toHaveLength(0);
  });
});

describe('a caller who is not signed in', () => {
  it('is redirected, not handed an error toast', async () => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(toggleDateOnCalendarAction('date-1')).rejects.toThrow('NEXT_REDIRECT');
  });
});
