// A calendar a family subscribes to (Settings → Calendar → Add & Sync Now, and
// the nightly cron) is imported as the school or club published it.
//
// Three ways it was not:
//
//   1. ZONE. `parseICS` kept only the property NAME of each content line, so
//      `DTSTART;TZID=America/New_York:20260906T090000` was read as 09:00 UTC —
//      a 9 am practice landed at 5 am. Every calendar exported from Outlook,
//      Apple or a school portal in local time was hours off.
//   2. SERIES. A rescheduled occurrence of a recurring event is a second VEVENT
//      with the SAME UID and a RECURRENCE-ID. The parser did not read
//      RECURRENCE-ID and the row builder deduped by UID, last write wins, so the
//      one-off replaced the weekly master: the whole series disappeared from the
//      family calendar except the moved week (or, exception first, the moved
//      week was lost). Any team with one changed practice hit this.
//   3. CANCELLED. `STATUS:CANCELLED` was parsed and then ignored, so a cancelled
//      event was imported as a live one, and an imported event the source later
//      cancelled stayed on the calendar for good.
//
// Now: TZID is honoured (lib/time/zoned, the same clock the rest of the app
// keeps; a zone this runtime does not know falls back to the old reading and
// says so in the parser's header), an exception is stored under the UID joined
// to its RECURRENCE-ID by a control character no UID can carry (0x1F; `#` was
// ambiguous with a stand-alone UID that contained it, review 5971622223) so
// neither it nor the master nor a look-alike can overwrite the other, and a
// cancelled event is a removal, scoped to the feed's own rows. Events the source
// simply DROPS are deliberately not removed — a rolling-window feed would erase a
// family's history on every sync — and that decision is recorded in
// lib/server/calendar-feeds.ts rather than made here.
//
// Known limit, stated: the app's recurrence model has no exception dates, so
// the master still renders the ORIGINAL slot of a moved or cancelled occurrence
// alongside the exception. One duplicate week, where before the series or the
// exception was lost outright.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { parseICS, parseIcsDate } from '@/lib/sync/ics';
import { buildFeedRows, feedExternalUid, planFeedRows } from '@/lib/calendar/feeds';

const mocks = vi.hoisted(() => ({ fetchPublicCalendarText: vi.fn() }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.fetchPublicCalendarText }));

import { syncFeed } from '@/lib/server/calendar-feeds';

const ROOT = join(__dirname, '..');
const FAMILY = 'fam-1';
const FEED = { id: 'feed-1', family_id: FAMILY, url: 'https://club.example/team.ics' };

/** A VCALENDAR from VEVENT bodies, CRLF-terminated as a server would send it. */
const ics = (...vevents: string[][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//club//EN',
  ...vevents.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
  'END:VCALENDAR', '',
].join('\r\n');

const MASTER = ['UID:series', 'SUMMARY:Soccer practice', 'DTSTART:20260905T140000Z', 'DTEND:20260905T150000Z', 'RRULE:FREQ=WEEKLY'];
const MOVED = ['UID:series', 'SUMMARY:Soccer practice (moved)', 'RECURRENCE-ID:20260912T140000Z', 'DTSTART:20260913T100000Z', 'DTEND:20260913T110000Z'];
const CANCELLED_WEEK = ['UID:series', 'SUMMARY:Soccer practice', 'RECURRENCE-ID:20260919T140000Z', 'DTSTART:20260919T140000Z', 'STATUS:CANCELLED'];
const CONCERT = ['UID:concert', 'SUMMARY:Autumn concert', 'DTSTART:20260920T180000Z', 'DTEND:20260920T200000Z'];
const CONCERT_OFF = [...CONCERT, 'STATUS:CANCELLED'];
const MOVED_KEY = 'series\u001F2026-09-12T14:00:00.000Z';
/** A stand-alone event whose UID is, character for character, the OLD key of the moved occurrence. */
const LOOKALIKE = ['UID:series#2026-09-12T14:00:00.000Z', 'SUMMARY:Unrelated talk', 'DTSTART:20260912T180000Z', 'DTEND:20260912T190000Z'];
const LOOKALIKE_UID = 'series#2026-09-12T14:00:00.000Z';
/** The 12 September occurrence cancelled outright: under the old key this shared `LOOKALIKE_UID`. */
const CANCELLED_MOVED_WEEK = ['UID:series', 'SUMMARY:Soccer practice', 'RECURRENCE-ID:20260912T140000Z', 'DTSTART:20260912T140000Z', 'STATUS:CANCELLED'];

const byUid = (events: ReturnType<typeof parseICS>, uid: string) => events.filter((e) => e.uid === uid);

describe('a start published in a named zone', () => {
  it('lands at the hour the zone meant, in summer and in winter', () => {
    const [summer, winter] = parseICS(ics(
      ['UID:s', 'SUMMARY:Practice', 'DTSTART;TZID=America/New_York:20260906T090000', 'DTEND;TZID=America/New_York:20260906T100000'],
      ['UID:w', 'SUMMARY:Practice', 'DTSTART;TZID=America/New_York:20260115T090000'],
    ));
    expect(summer.startsAt).toBe('2026-09-06T13:00:00.000Z');
    expect(summer.endsAt).toBe('2026-09-06T14:00:00.000Z');
    expect(summer.allDay).toBe(false);
    expect(winter.startsAt).toBe('2026-01-15T14:00:00.000Z');
  });

  it('keeps UTC and all-day values exactly as before', () => {
    const [utc, allDay] = parseICS(ics(
      ['UID:u', 'SUMMARY:Match', 'DTSTART:20261016T090000Z', 'DTEND:20261016T150000Z'],
      ['UID:d', 'SUMMARY:Term starts', 'DTSTART;VALUE=DATE:20261005'],
    ));
    expect(utc.startsAt).toBe('2026-10-16T09:00:00.000Z');
    expect(allDay).toMatchObject({ startsAt: '2026-10-05T00:00:00.000Z', allDay: true });
  });

  it('reads a reading the zone skips at spring-forward as the first minute that exists', () => {
    // New York jumps from 02:00 to 03:00 on 2026-03-08; 02:30 never happens.
    expect(parseIcsDate('20260308T023000', 'America/New_York').iso).toBe('2026-03-08T07:00:00.000Z');
  });

  it('keeps the seconds of a zoned reading', () => {
    expect(parseIcsDate('20260906T090015', 'America/New_York').iso).toBe('2026-09-06T13:00:15.000Z');
  });

  it('a quoted zone name with a colon in it is a parameter, not the value', () => {
    // Outlook's form. The zone itself is not an IANA name, so the reading falls
    // back to the floating rule — but the VALUE is now the date, where before
    // the first colon split inside the parameter and the event was dropped.
    const [ev] = parseICS(ics(['UID:o', 'SUMMARY:Standup', 'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260906T090000']));
    expect(ev).toBeDefined();
    expect(ev.startsAt).toBe('2026-09-06T09:00:00.000Z');
  });

  it('a zone this runtime does not know falls back to the floating reading — the stated limit', () => {
    expect(parseIcsDate('20260906T090000', 'Eastern Standard Time').iso).toBe('2026-09-06T09:00:00.000Z');
    expect(parseIcsDate('20260906T090000', null).iso).toBe('2026-09-06T09:00:00.000Z');
  });

  it('reads RECURRENCE-ID in the zone it was published in', () => {
    const [ev] = parseICS(ics(['UID:r', 'SUMMARY:Moved', 'RECURRENCE-ID;TZID=America/New_York:20260912T100000', 'DTSTART;TZID=America/New_York:20260913T060000']));
    expect(ev.recurrenceId).toBe('2026-09-12T14:00:00.000Z');
    expect(ev.startsAt).toBe('2026-09-13T10:00:00.000Z');
  });
});

describe('a recurring series and its exceptions', () => {
  it.each([
    ['exception after the master', [MASTER, MOVED]],
    ['exception before the master', [MOVED, MASTER]],
  ])('keep the master and store the moved occurrence as its own event (%s)', (_label, order) => {
    const events = parseICS(ics(...order));
    expect(byUid(events, 'series').map((e) => e.recurrenceId)).toEqual(expect.arrayContaining([null, '2026-09-12T14:00:00.000Z']));

    const { rows, cancelled } = planFeedRows(events, FAMILY, FEED.id);
    expect(cancelled).toEqual([]);
    const master = rows.find((r) => r.external_uid === 'series');
    const moved = rows.find((r) => r.external_uid === MOVED_KEY);
    expect(master, 'the series master is still a row').toMatchObject({ title: 'Soccer practice', starts_at: '2026-09-05T14:00:00.000Z', recurrence: 'weekly' });
    expect(moved, 'the moved occurrence is a one-off of its own').toMatchObject({ title: 'Soccer practice (moved)', starts_at: '2026-09-13T10:00:00.000Z', recurrence: 'none' });
    expect(rows).toHaveLength(2);
  });

  it('a cancelled occurrence is a removal of that occurrence only', () => {
    const { rows, cancelled } = planFeedRows(parseICS(ics(MASTER, CANCELLED_WEEK)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['series']);
    expect(cancelled).toEqual(['series\u001F2026-09-19T14:00:00.000Z']);
  });

  it('a cancelled master is a removal of the series', () => {
    const { rows, cancelled } = planFeedRows(parseICS(ics([...MASTER, 'STATUS:CANCELLED'], CONCERT)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['concert']);
    expect(cancelled).toEqual(['series']);
  });

  it('a plain repeated UID still lets the last write win, so a feed that repeats itself upserts cleanly', () => {
    const { rows } = planFeedRows(parseICS(ics([...CONCERT, 'SUMMARY:Old'], CONCERT)), FAMILY, FEED.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Autumn concert');
  });

  it('buildFeedRows is the rows half of the plan, and the key is one function', () => {
    const events = parseICS(ics(MASTER, MOVED, CONCERT_OFF));
    expect(buildFeedRows(events, FAMILY, FEED.id)).toEqual(planFeedRows(events, FAMILY, FEED.id).rows);
    expect(feedExternalUid({ uid: 'series', recurrenceId: '2026-09-12T14:00:00.000Z' })).toBe(MOVED_KEY);
    expect(feedExternalUid({ uid: 'series', recurrenceId: null })).toBe('series');
  });
});

describe('a sync against the family calendar', () => {
  let db: InMemorySupabase;
  const client = () => db as unknown as SupabaseClient<Database>;
  const feedEvents = () => db.table('calendar_events').filter((r) => r.feed_id === FEED.id) as Row[];
  const feedRow = () => db.table('calendar_feeds').find((r) => r.id === FEED.id) as Row;
  const reachable = (text: string) => mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text });

  beforeEach(() => {
    db = createInMemorySupabase({
      // 0285: one row per (feed, external uid), the upsert's conflict target.
      uniques: { calendar_events: [['feed_id', 'external_uid']] },
    });
    db.seed('calendar_feeds', [{ ...FEED, name: 'Team', last_status: null, last_error: null, last_synced_at: null, event_count: 0 }]);
    mocks.fetchPublicCalendarText.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('heals a series an earlier sync had collapsed, and imports the moved occurrence beside it', async () => {
    // What the old builder left behind: the master row overwritten by the one-off.
    db.seed('calendar_events', [{
      id: 'ev-1', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Soccer practice (moved)',
      starts_at: '2026-09-13T10:00:00.000Z', ends_at: '2026-09-13T11:00:00.000Z', recurrence: 'none', category: 'general', all_day: false,
    }]);
    reachable(ics(MASTER, MOVED, CONCERT));

    const result = await syncFeed(client(), FEED);

    expect(result).toEqual({ ok: true, imported: 3 });
    const master = feedEvents().find((r) => r.external_uid === 'series');
    expect(master, 'the same row, healed in place').toMatchObject({ id: 'ev-1', title: 'Soccer practice', recurrence: 'weekly', starts_at: '2026-09-05T14:00:00.000Z' });
    expect(feedEvents().find((r) => r.external_uid === MOVED_KEY)).toMatchObject({ title: 'Soccer practice (moved)', recurrence: 'none' });
    expect(feedEvents()).toHaveLength(3);
    expect(feedRow()).toMatchObject({ last_status: 'ok', last_error: null, event_count: 3 });
    expect(feedRow().last_synced_at).toBeTruthy();
  });

  it('removes an event the source has since cancelled, and nothing else', async () => {
    db.seed('calendar_events', [
      { id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' },
      // The same uid under ANOTHER feed, and a family event of its own: neither is this feed's to touch.
      { id: 'ev-other-feed', family_id: FAMILY, feed_id: 'feed-2', external_uid: 'concert', title: 'Choir concert', starts_at: '2026-09-21T18:00:00.000Z', recurrence: 'none' },
      { id: 'ev-manual', family_id: FAMILY, feed_id: null, external_uid: null, title: 'Dentist', starts_at: '2026-09-22T09:00:00.000Z', recurrence: 'none' },
    ]);
    reachable(ics(MASTER, CONCERT_OFF));

    const result = await syncFeed(client(), FEED);

    expect(result).toEqual({ ok: true, imported: 1 });
    expect(db.table('calendar_events').map((r) => r.id).sort()).toEqual(['ev-manual', 'ev-other-feed', expect.any(String)].sort());
    expect(db.table('calendar_events').find((r) => r.id === 'ev-concert')).toBeUndefined();
    expect(feedEvents().map((r) => r.external_uid)).toEqual(['series']);
    expect(feedRow()).toMatchObject({ last_status: 'ok', event_count: 1 });
  });

  // Review 5971622223 on #908: under the old `uid#recurrenceId` key, a
  // stand-alone event whose UID happened to be `series#2026-09-12T14:00:00.000Z`
  // shared a key with the moved 12 September occurrence, so one of them was lost
  // in the plan — and when that occurrence was cancelled, the feed-scoped delete
  // took the stand-alone event with it.
  it('keeps a stand-alone event whose UID looks like an exception key beside the moved occurrence it looks like', async () => {
    reachable(ics(MASTER, MOVED, LOOKALIKE));
    const result = await syncFeed(client(), FEED);
    expect(result).toEqual({ ok: true, imported: 3 });
    const keys = feedEvents().map((r) => r.external_uid as string).sort();
    expect(new Set(keys).size, 'three rows, three keys').toBe(3);
    expect(keys).toContain(LOOKALIKE_UID);
    expect(keys).toContain(MOVED_KEY);
    expect(feedEvents().map((r) => r.title).sort()).toEqual(['Soccer practice', 'Soccer practice (moved)', 'Unrelated talk']);
  });

  it.each([
    ['the cancelled occurrence before the look-alike', [MASTER, CANCELLED_MOVED_WEEK, LOOKALIKE]],
    ['the look-alike before the cancelled occurrence', [MASTER, LOOKALIKE, CANCELLED_MOVED_WEEK]],
  ])('cancelling the occurrence does not remove the look-alike, with %s', async (_order, vevents) => {
    // Imported on an earlier sync, under the bare UID every one-off is stored by.
    db.seed('calendar_events', [{ id: 'ev-lookalike', family_id: FAMILY, feed_id: FEED.id, external_uid: LOOKALIKE_UID, title: 'Unrelated talk', starts_at: '2026-09-12T18:00:00.000Z', recurrence: 'none' }]);
    reachable(ics(...vevents));
    const result = await syncFeed(client(), FEED);
    expect(result).toEqual({ ok: true, imported: 2 });
    expect(db.table('calendar_events').find((r) => r.id === 'ev-lookalike'), 'the stand-alone event survives the cancellation').toBeDefined();
    expect(feedEvents().map((r) => r.external_uid).sort()).toEqual([LOOKALIKE_UID, 'series'].sort());
    expect(feedRow()).toMatchObject({ last_status: 'ok', event_count: 2 });
  });

  it('an exception key can never equal a bare UID, whatever the publisher wrote', () => {
    for (const uid of ['series', LOOKALIKE_UID, 'odd\u001Fuid', `${MOVED_KEY}`]) {
      expect(feedExternalUid({ uid, recurrenceId: null }), uid).not.toContain('\u001F');
    }
    expect(feedExternalUid({ uid: 'series', recurrenceId: '2026-09-12T14:00:00.000Z' })).toBe(MOVED_KEY);
    // A UID that arrives carrying the separator (invalid ICS) is stripped of it,
    // so it reads as a one-off and cannot impersonate the moved occurrence.
    expect(feedExternalUid({ uid: MOVED_KEY, recurrenceId: null })).toBe('series2026-09-12T14:00:00.000Z');
    expect(feedExternalUid({ uid: MOVED_KEY, recurrenceId: null })).not.toBe(MOVED_KEY);
  });

  it('a cancellation of something the family never imported is not a failure', async () => {
    reachable(ics(MASTER, CONCERT_OFF, CANCELLED_WEEK));
    const result = await syncFeed(client(), FEED);
    expect(result).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.external_uid)).toEqual(['series']);
    expect(feedRow().last_status).toBe('ok');
  });

  it('a refused removal is reported and stamped on the feed, not swallowed as a clean sync', async () => {
    db.seed('calendar_events', [{ id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' }]);
    reachable(ics(MASTER, CONCERT_OFF));
    const refused = { code: '42501', message: 'permission denied for table calendar_events' };
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown>;
          if (table === 'calendar_events') {
            builder.delete = () => {
              const chain: Record<string, unknown> = {};
              Object.assign(chain, {
                eq: () => chain, in: () => chain, select: () => chain,
                then: (resolve: (v: unknown) => void) => resolve({ data: null, error: refused }),
              });
              return chain;
            };
          }
          return builder;
        };
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await syncFeed(flaky as unknown as SupabaseClient<Database>, FEED);

    expect(result).toEqual({ ok: false, error: 'Could not remove cancelled events' });
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'Could not remove cancelled events' });
    expect(db.table('calendar_events').find((r) => r.id === 'ev-concert'), 'nothing was removed').toBeDefined();
  });

  it('removes only through a statement scoped to this feed and confirmed to have run', () => {
    const src = readFileSync(join(ROOT, 'lib/server/calendar-feeds.ts'), 'utf8');
    const removal = src.slice(src.indexOf('.delete()'), src.indexOf("Could not remove cancelled events"));
    expect(removal).toContain(".eq('feed_id', feed.id)");
    expect(removal).toContain(".in('external_uid', chunk)");
    expect(removal).toContain(".select('id')");
    // The upsert's conflict target is unchanged: the index 0285 built.
    expect(src).toContain("onConflict: 'feed_id,external_uid'");
  });
});
