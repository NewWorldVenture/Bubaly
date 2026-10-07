import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { parseICS } from '@/lib/sync/ics';
import { planFeedRows } from '@/lib/calendar/feeds';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { applyCalendarFeedSync } from './helpers/calendar-feed-apply';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.fetch }));
import { APPLY_SYNC_FUNCTION, syncFeed } from '@/lib/server/calendar-feeds';
const FEED = { id: 'feed', family_id: 'family', url: 'https://example.test/calendar.ics' };
const ics = (...components: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...components.flatMap(properties => ['BEGIN:VEVENT', ...properties, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const single = ['UID:new', 'SUMMARY:New appointment', 'DTSTART;TZID=America/New_York:20261001T090000'];
// Each witness previously reached the row planner and misleadingly expanded.
// Admission now rejects the whole snapshot, including its otherwise valid writes/removals.
const witnesses = [
  { name: 'recurring nominal duration not preserved', components: [['UID:series','SUMMARY:Class','DTSTART;VALUE=DATE:20261001','DURATION:P2D','RRULE:FREQ=WEEKLY']] },
  { name: 'deprecated exception rule not preserved', components: [['UID:series','SUMMARY:Class','DTSTART;VALUE=DATE:20261001','RRULE:FREQ=DAILY','EXRULE:FREQ=WEEKLY;BYDAY=SA,SU']] },
  { name: 'unplaceable all-day rule', components: [['UID:series','DTSTART;VALUE=DATE:20261001','RRULE:FREQ=DAILY']] },

  {
    "name": "nonexistent recurring local time",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART;TZID=America/Chicago:20260301T023000",
        "RRULE:FREQ=WEEKLY"
      ]
    ]
  },
  {
    "name": "finite COUNT",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261001T100000Z",
        "RRULE:FREQ=DAILY;COUNT=2"
      ]
    ]
  },
  {
    "name": "finite UNTIL",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261001T100000Z",
        "RRULE:FREQ=DAILY;UNTIL=20261002T100000Z"
      ]
    ]
  },
  {
    "name": "weekly INTERVAL",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY;INTERVAL=2"
      ]
    ]
  },
  {
    "name": "weekly BYDAY",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"
      ]
    ]
  },
  {
    "name": "source TZID drift",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART;TZID=America/New_York:20260223T090000",
        "RRULE:FREQ=WEEKLY"
      ]
    ]
  },
  {
    "name": "source UTC drift",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20260223T090000Z",
        "RRULE:FREQ=WEEKLY"
      ]
    ]
  },
  {
    "name": "same-zone control",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART;TZID=America/New_York:20260223T090000",
        "RRULE:FREQ=WEEKLY"
      ]
    ]
  },
  {
    "name": "EXDATE discarded",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY",
        "EXDATE:20261012T100000Z"
      ]
    ]
  },
  {
    "name": "moved original remains",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY"
      ],
      [
        "UID:series",
        "SUMMARY:Moved class",
        "RECURRENCE-ID:20261012T100000Z",
        "DTSTART:20261013T110000Z"
      ]
    ]
  },
  {
    "name": "cancelled original remains",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY"
      ],
      [
        "UID:series",
        "RECURRENCE-ID:20261012T100000Z",
        "STATUS:CANCELLED"
      ]
    ]
  },
  {
    "name": "RDATE discarded",
    "components": [
      [
        "UID:series",
        "SUMMARY:Source class",
        "DTSTART:20261005T100000Z",
        "RRULE:FREQ=WEEKLY",
        "RDATE:20261013T100000Z"
      ]
    ]
  },
  {
    "name": "all-day finite count",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=DAILY;COUNT=2"
      ]
    ]
  },
  {
    "name": "all-day finite until",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=DAILY;UNTIL=20261002"
      ]
    ]
  },
  {
    "name": "all-day interval",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=WEEKLY;INTERVAL=2"
      ]
    ]
  },
  {
    "name": "all-day byday",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"
      ]
    ]
  },
  {
    "name": "unsupported monthly",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=MONTHLY"
      ]
    ]
  },
  {
    "name": "empty rule",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:"
      ]
    ]
  },
  {
    "name": "duplicate rule",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART;VALUE=DATE:20261001",
        "RRULE:FREQ=DAILY",
        "RRULE:FREQ=WEEKLY"
      ]
    ]
  },
  {
    "name": "unplaceable recurrence",
    "components": [
      [
        "UID:series",
        "RRULE:FREQ=DAILY;COUNT=2"
      ]
    ]
  },
  {
    "name": "unplaceable exdate",
    "components": [
      [
        "UID:series",
        "EXDATE:20261012T100000Z"
      ]
    ]
  },
  {
    "name": "rdate without rule",
    "components": [
      [
        "UID:series",
        "SUMMARY:Class",
        "DTSTART:20261001T100000Z",
        "RDATE:20261013T100000Z"
      ]
    ]
  },
  {
    "name": "range exception",
    "components": [
      [
        "UID:series",
        "SUMMARY:Moved",
        "DTSTART:20261013T110000Z",
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20261012T100000Z"
      ]
    ]
  }
];

beforeEach(() => mocks.fetch.mockReset());
describe('feed recurrence admission precedes every event write and removal', () => {
  it.each(witnesses)('refuses $name without applying any part of the snapshot', async ({ components }) => {
    const apply = vi.fn(applyCalendarFeedSync);
    const db = createInMemorySupabase({ rpc: { [APPLY_SYNC_FUNCTION]: apply } });
    db.seed('calendar_feeds', [{ ...FEED, last_status: 'ok', event_count: 2, last_synced_at: '2026-09-01T00:00:00Z' }]);
    db.seed('calendar_events', [
      { id: 'existing', feed_id: FEED.id, family_id: FEED.family_id, external_uid: 'remove', title: 'Retained appointment' },
      { id: 'other', feed_id: 'other-feed', family_id: FEED.family_id, external_uid: 'remove', title: 'Other feed' },
    ]);
    const before = structuredClone(db.table('calendar_events'));
    mocks.fetch.mockResolvedValue({ ok: true, text: ics(single, ['UID:remove', 'STATUS:CANCELLED'], ...components) });
    const result = await syncFeed(db as unknown as SupabaseClient<Database>, FEED);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Unsupported .*recurrence/) });
    expect(apply).not.toHaveBeenCalled();
    expect(db.table('calendar_events')).toEqual(before);
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: 'error', event_count: 2, last_synced_at: '2026-09-01T00:00:00Z' });
    expect(db.table('calendar_feeds')[0].last_error).toEqual(result.ok ? '' : result.error);
  });

  it.each(['DAILY', 'WEEKLY'])('imports and correctly reads all-day FREQ=%s through DST and year boundaries', async (frequency) => {
    const component = ['UID:dates', 'SUMMARY:All-day series', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261027', `RRULE:FREQ=${frequency}`];
    const parsed = parseICS(ics(component));
    expect(planFeedRows(parsed, FEED.family_id, FEED.id).rows).toHaveLength(1);
    const apply = vi.fn(applyCalendarFeedSync);
    const db = createInMemorySupabase({ maxRows: 1, rpc: { [APPLY_SYNC_FUNCTION]: apply } });
    db.seed('calendar_feeds', [{ ...FEED, last_status: 'ok' }]);
    mocks.fetch.mockResolvedValue({ ok: true, text: ics(component) });
    expect(await syncFeed(db as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: true, imported: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
    for (const [day, zone] of [['2026-11-01', 'America/New_York'], ['2027-01-03', 'Pacific/Auckland']]) {
      const result = await readCalendarOccurrences(db as never, FEED.family_id, briefingCalendarBounds(day, zone, 0, 1), zone);
      expect(result.error).toBeNull();
      expect(result.data).toHaveLength(1);
      const expectedEnd = day === '2026-11-01' ? '2026-11-03' : '2027-01-05';
      expect(result.data?.[0]).toMatchObject({ starts_at: `${day}T00:00:00.000Z`, ends_at: `${expectedEnd}T00:00:00.000Z`, all_day: true });
    }
  });

  it('still imports a strictly zoned single and removes a bare cancelled master with stored exceptions', async () => {
    const apply = vi.fn(applyCalendarFeedSync);
    const db = createInMemorySupabase({ rpc: { [APPLY_SYNC_FUNCTION]: apply } });
    db.seed('calendar_feeds', [{ ...FEED, last_status: 'ok' }]);
    db.seed('calendar_events', [
      { id: 'master', feed_id: FEED.id, external_uid: 'remove' },
      { id: 'exception', feed_id: FEED.id, external_uid: 'remove\u001F2026-10-01T10:00:00.000Z' },
      { id: 'other', feed_id: 'other-feed', external_uid: 'remove' },
    ]);
    mocks.fetch.mockResolvedValue({ ok: true, text: ics(single, ['UID:remove', 'STATUS:CANCELLED']) });
    expect(await syncFeed(db as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: true, imported: 1 });
    expect(db.table('calendar_events').map(row => row.id)).not.toEqual(expect.arrayContaining(['master', 'exception']));
    expect(db.table('calendar_events').find(row => row.id === 'other')).toBeDefined();
    expect(db.table('calendar_events').find(row => row.external_uid === 'new')).toMatchObject({ starts_at: '2026-10-01T13:00:00.000Z', recurrence: 'none' });
  });

  it('keeps EXDATE/RDATE as presence metadata without changing generic rule parsing', () => {
    const [event] = parseICS(ics(['UID:series','SUMMARY:Class','DTSTART:20261001T100000Z','RRULE:FREQ=DAILY;COUNT=2','EXDATE:20261002T100000Z','RDATE:20261003T100000Z']));
    expect(event).toMatchObject({ recurrenceRule: 'FREQ=DAILY;COUNT=2', hasExdates: true, hasRdates: true });
    expect(planFeedRows([event], FEED.family_id, FEED.id).rows).toHaveLength(1);
  });

  it('keeps refusing an unknown explicit DTSTART zone as a parse error', async () => {
    const apply = vi.fn(applyCalendarFeedSync);
    const db = createInMemorySupabase({ rpc: { [APPLY_SYNC_FUNCTION]: apply } });
    db.seed('calendar_feeds', [{ ...FEED, last_status: 'ok' }]);
    mocks.fetch.mockResolvedValue({ ok: true, text: ics(['UID:unknown','SUMMARY:Class','DTSTART;TZID=Made/Up:20261001T090000']) });
    expect(await syncFeed(db as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: false, error: 'Could not parse the calendar' });
    expect(apply).not.toHaveBeenCalled();
  });
});
