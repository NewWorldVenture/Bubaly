// A moved or cancelled occurrence of a subscribed series leaves its old slot
// empty.
//
// #908 made a recurring series survive its exceptions: a VEVENT with a
// RECURRENCE-ID — a rescheduled or cancelled occurrence, sharing the master's
// UID — is stored under its own key instead of overwriting the master. Its
// stated limit was that the recurrence model (`recurrence` + `recurrence_until`,
// expanded by lib/calendar/recurrence.ts) had no way to say "except this one":
// the master still rendered the Saturday beside the moved Sunday, a cancelled
// week still rendered, and EXDATE lines were ignored entirely.
//
// `calendar_events.exception_dates` (the migration this test finds by name)
// holds the instants a series has given up. The feed planner fills it from the
// RECURRENCE-IDs of the feed's exceptions and the master's EXDATEs; the
// expander skips an occurrence on the same LOCAL DAY as one of them — the day,
// not the instant, because a series has at most one occurrence a day and the
// source's instant and ours can differ by an hour across a DST change when the
// series was published in another zone. On a database without the column the
// sync writes the rows without it and says so once, so a deploy that precedes
// its migration still syncs as before.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { generateICS, parseICS } from '@/lib/sync/ics';
import { planFeedRows } from '@/lib/calendar/feeds';
import { expandEventsInZone, type RecurrableEvent } from '@/lib/calendar/recurrence';

const mocks = vi.hoisted(() => ({ fetchPublicCalendarText: vi.fn() }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.fetchPublicCalendarText }));

import { syncFeed } from '@/lib/server/calendar-feeds';

const ROOT = join(__dirname, '..');
const FAMILY = 'fam-1';
const FEED = { id: 'feed-1', family_id: FAMILY, url: 'https://club.example/team.ics' };
const SLUG = '_a_series_remembers_the_occurrences_it_gave_up.sql';

const ics = (...vevents: string[][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//club//EN',
  ...vevents.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
  'END:VCALENDAR', '',
].join('\r\n');

const MASTER = ['UID:series', 'SUMMARY:Soccer practice', 'DTSTART:20260905T140000Z', 'DTEND:20260905T150000Z', 'RRULE:FREQ=WEEKLY'];
const MOVED = ['UID:series', 'SUMMARY:Soccer practice (moved)', 'RECURRENCE-ID:20260912T140000Z', 'DTSTART:20260913T100000Z', 'DTEND:20260913T110000Z'];
const CANCELLED_WEEK = ['UID:series', 'SUMMARY:Soccer practice', 'RECURRENCE-ID:20260919T140000Z', 'DTSTART:20260919T140000Z', 'STATUS:CANCELLED'];
const SEP_12 = '2026-09-12T14:00:00.000Z';
const SEP_19 = '2026-09-19T14:00:00.000Z';
const SEP_26 = '2026-09-26T14:00:00.000Z';

const starts = (events: readonly { starts_at: string }[]) => events.map((e) => e.starts_at);
const series = (over: Partial<RecurrableEvent> = {}): RecurrableEvent => ({
  id: 'series', starts_at: '2026-09-05T14:00:00.000Z', ends_at: '2026-09-05T15:00:00.000Z', recurrence: 'weekly', recurrence_until: null, ...over,
});
const september = (e: RecurrableEvent, zone = 'UTC') => expandEventsInZone([e], new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), zone);

describe('the parser reads what a series has given up', () => {
  it('EXDATE: one, a list, several lines, in a zone, as a date', () => {
    const [ev] = parseICS(ics([
      ...MASTER,
      'EXDATE:20260912T140000Z',
      'EXDATE:20260919T140000Z,20260926T140000Z',
      'EXDATE;TZID=America/New_York:20261003T100000',
      'EXDATE;VALUE=DATE:20261010',
    ]));
    expect(ev.exceptionDates).toEqual([SEP_12, SEP_19, SEP_26, '2026-10-03T14:00:00.000Z', '2026-10-10T00:00:00.000Z']);
  });

  it('an event without EXDATE has none', () => {
    expect(parseICS(ics(MASTER))[0].exceptionDates).toEqual([]);
  });

  it('a series Bubaly publishes carries what it gave up, and it survives the round trip', () => {
    const timed = generateICS([{ uid: 'series', title: 'Soccer practice', startsAt: '2026-09-05T14:00:00.000Z', endsAt: '2026-09-05T15:00:00.000Z', recurrenceRule: 'FREQ=WEEKLY', exceptionDates: [SEP_12, SEP_19] }], { name: 'Team', dtstamp: '2026-09-01T00:00:00.000Z' });
    expect(timed).toContain('EXDATE:20260912T140000Z,20260919T140000Z');
    expect(parseICS(timed)[0].exceptionDates).toEqual([SEP_12, SEP_19]);

    const allDay = generateICS([{ uid: 'camp', title: 'Camp', startsAt: '2026-09-01T00:00:00.000Z', allDay: true, recurrenceRule: 'FREQ=DAILY', exceptionDates: ['2026-09-03T00:00:00.000Z'] }], { name: 'Team', dtstamp: '2026-09-01T00:00:00.000Z' });
    expect(allDay).toContain('EXDATE;VALUE=DATE:20260903');
    expect(parseICS(allDay)[0].exceptionDates).toEqual(['2026-09-03T00:00:00.000Z']);

    const none = generateICS([{ uid: 'one', title: 'One-off', startsAt: '2026-09-20T18:00:00.000Z' }], { name: 'Team', dtstamp: '2026-09-01T00:00:00.000Z' });
    expect(none).not.toContain('EXDATE');
  });
});

describe('the feed planner hands the master the occurrences it gave up', () => {
  it('a moved occurrence: the master forgets the Saturday, the Sunday is its own event', () => {
    const { rows } = planFeedRows(parseICS(ics(MASTER, MOVED)), FAMILY, FEED.id);
    expect(rows.find((r) => r.external_uid === 'series')?.exception_dates).toEqual([SEP_12]);
    expect(rows.find((r) => r.external_uid === `series#${SEP_12}`)?.exception_dates).toEqual([]);
  });

  it('a cancelled occurrence: the master forgets it, and it is a removal', () => {
    const { rows, cancelled } = planFeedRows(parseICS(ics(CANCELLED_WEEK, MASTER)), FAMILY, FEED.id);
    expect(rows.find((r) => r.external_uid === 'series')?.exception_dates).toEqual([SEP_19]);
    expect(cancelled).toEqual([`series#${SEP_19}`]);
  });

  it('EXDATEs and exception VEVENTs are one sorted set, however the feed orders them', () => {
    const { rows } = planFeedRows(parseICS(ics(MOVED, [...MASTER, 'EXDATE:20260926T140000Z', 'EXDATE:20260912T140000Z'], CANCELLED_WEEK)), FAMILY, FEED.id);
    expect(rows.find((r) => r.external_uid === 'series')?.exception_dates).toEqual([SEP_12, SEP_19, SEP_26]);
  });

  it('an exception whose master is not in the feed stands alone, and a one-off has nothing to give up', () => {
    const { rows } = planFeedRows(parseICS(ics(MOVED, ['UID:concert', 'SUMMARY:Concert', 'DTSTART:20260920T180000Z'])), FAMILY, FEED.id);
    expect(rows.map((r) => [r.external_uid, r.exception_dates])).toEqual([[`series#${SEP_12}`, []], ['concert', []]]);
  });
});

describe('the expander leaves a given-up slot empty', () => {
  it('a weekly series misses the week it gave up and keeps every other', () => {
    expect(starts(september(series()))).toEqual(['2026-09-05T14:00:00.000Z', SEP_12, SEP_19, SEP_26]);
    expect(starts(september(series({ exception_dates: [SEP_12] })))).toEqual(['2026-09-05T14:00:00.000Z', SEP_19, SEP_26]);
    expect(starts(september(series({ exception_dates: [SEP_12, SEP_26] })))).toEqual(['2026-09-05T14:00:00.000Z', SEP_19]);
  });

  it('matches by local day, so an instant published in another zone across a DST change still names the right week', () => {
    // Weekly at 18:00 Berlin = 16:00Z before Europe's clocks fall back on
    // 2026-10-25, 17:00Z after. A New York family (clocks fall back 2026-11-01)
    // steps the series at 12:00 local: 16:00Z on 10-24 and 10-31, 17:00Z from
    // 11-07. The source names the 10-31 occurrence as 17:00Z; ours is 16:00Z.
    // Same New York day; the week is skipped.
    const e = series({ starts_at: '2026-10-24T16:00:00.000Z', ends_at: '2026-10-24T17:00:00.000Z', exception_dates: ['2026-10-31T17:00:00.000Z'] });
    const out = expandEventsInZone([e], new Date('2026-10-20T00:00:00Z'), new Date('2026-11-10T00:00:00Z'), 'America/New_York');
    expect(starts(out)).toEqual(['2026-10-24T16:00:00.000Z', '2026-11-07T17:00:00.000Z']);
  });

  it('an all-day series gives up a day', () => {
    const e = series({ starts_at: '2026-09-01T00:00:00.000Z', ends_at: null, recurrence: 'daily', exception_dates: ['2026-09-03T00:00:00.000Z'] });
    const out = expandEventsInZone([e], new Date('2026-09-01T00:00:00Z'), new Date('2026-09-05T00:00:00Z'), 'UTC');
    expect(starts(out)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-04T00:00:00.000Z']);
    // The same rows read by a family in another zone: cursor and exception are
    // keyed through the same clock, so the same day is skipped.
    const ny = expandEventsInZone([e], new Date('2026-09-01T00:00:00Z'), new Date('2026-09-05T00:00:00Z'), 'America/New_York');
    expect(starts(ny)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-04T00:00:00.000Z']);
  });

  it('ignores an unparseable exception and leaves a one-off alone', () => {
    expect(starts(september(series({ exception_dates: ['not a date', ''] })))).toHaveLength(4);
    const once = series({ recurrence: 'none', exception_dates: ['2026-09-05T14:00:00.000Z'] });
    expect(september(once)).toEqual([once]);
  });
});

describe('a sync against the family calendar', () => {
  let db: InMemorySupabase;
  const client = () => db as unknown as SupabaseClient<Database>;
  const feedEvents = () => db.table('calendar_events').filter((r) => r.feed_id === FEED.id) as Row[];
  const feedRow = () => db.table('calendar_feeds').find((r) => r.id === FEED.id) as Row;
  const reachable = (text: string) => mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text });

  beforeEach(() => {
    db = createInMemorySupabase({ uniques: { calendar_events: [['feed_id', 'external_uid']] } });
    db.seed('calendar_feeds', [{ ...FEED, name: 'Team', last_status: null, last_error: null, last_synced_at: null, event_count: 0 }]);
    mocks.fetchPublicCalendarText.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores what the master gave up, and the month then shows the moved practice once', async () => {
    reachable(ics(MASTER, MOVED, CANCELLED_WEEK));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 2 });

    const master = feedEvents().find((r) => r.external_uid === 'series');
    expect(master?.exception_dates).toEqual([SEP_12, SEP_19]);

    const stored = feedEvents().map((r) => ({ ...r, exception_dates: r.exception_dates as string[] })) as unknown as RecurrableEvent[];
    const month = expandEventsInZone(stored, new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), 'UTC');
    expect(starts(month)).toEqual(['2026-09-05T14:00:00.000Z', '2026-09-13T10:00:00.000Z', SEP_26]);
  });

  it('on a database without the column, writes the rows without it and says so once', async () => {
    reachable(ics(MASTER, MOVED));
    const refusal = { code: 'PGRST204', message: "Could not find the 'exception_dates' column of 'calendar_events' in the schema cache" };
    let refusals = 0;
    const older = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown> & { upsert: (rows: Row[], opts?: unknown) => unknown };
          if (table === 'calendar_events') {
            const real = builder.upsert.bind(builder);
            builder.upsert = (rows: Row[], opts?: unknown) => {
              if (rows.some((r) => 'exception_dates' in r)) {
                refusals += 1;
                return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: refusal }) };
              }
              return real(rows, opts);
            };
          }
          return builder;
        };
      },
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await syncFeed(older as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: true, imported: 2 });
    expect(refusals, 'asked once, then wrote without the column').toBe(1);
    expect(feedEvents()).toHaveLength(2);
    expect(feedEvents().every((r) => !('exception_dates' in r))).toBe(true);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0][0])).toMatch(/exception_dates.*migration/);
    expect(feedRow().last_status).toBe('ok');
  });

  it('any other refusal of the upsert is still a failed sync', async () => {
    reachable(ics(MASTER));
    const refusal = { code: '42501', message: 'permission denied for table calendar_events' };
    const denied = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown>;
          if (table === 'calendar_events') builder.upsert = () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: null, error: refusal }) });
          return builder;
        };
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await syncFeed(denied as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: false, error: 'Could not save calendar events' });
    expect(feedRow().last_status).toBe('error');
  });
});

describe('the shape of the change', () => {
  it('the migration adds the one column, additively', () => {
    const file = readdirSync(join(ROOT, 'supabase/migrations')).find((f) => f.endsWith(SLUG));
    expect(file, 'the migration is in the tree').toBeTruthy();
    expect(file).toMatch(/^\d{4}_/);
    const sql = readFileSync(join(ROOT, 'supabase/migrations', file as string), 'utf8');
    expect(sql).toContain("add column if not exists exception_dates timestamptz[] not null default '{}'");
    expect(sql).not.toMatch(/create policy|drop policy|create index|create function/i);
  });

  it('the row types and the assistant read carry the column, and the expander keys exceptions by local day', () => {
    const types = readFileSync(join(ROOT, 'lib/database.types.ts'), 'utf8');
    expect(types).toMatch(/recurrence_until: string \| null; exception_dates: string\[\];/);
    expect(types).toMatch(/recurrence_until\?: string \| null; exception_dates\?: string\[\];/);
    const assistant = readFileSync(join(ROOT, 'lib/assistant/service.ts'), 'utf8');
    expect(assistant).toContain("recurrence, recurrence_until, exception_dates'");
    const expander = readFileSync(join(ROOT, 'lib/calendar/recurrence.ts'), 'utf8');
    expect(expander).toContain('exceptionDays.has(dayKeyIn(cursor, timezone))');
  });
});
