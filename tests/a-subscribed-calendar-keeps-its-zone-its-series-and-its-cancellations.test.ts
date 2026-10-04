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
//
// Review on #908 (comment 5976737100), two more:
//
//   4. A cancelled master named only its bare UID, and the removal matched exact
//      keys, so the exceptions an earlier sync had imported (`uid␟recurrenceId`)
//      outlived their series. Now a cancelled master is a `cancelledSeries`
//      entry; the sync reads this feed's stored keys and removes every one under
//      that UID, by exact key — a UID may carry LIKE's own wildcards.
//   5. The nightly cron and a member's "Sync now" could run the same feed at
//      once, and the one holding the OLDER snapshot could delete what the newer
//      one had just written, or write back what it had just removed. Now one
//      sync of a feed runs at a time: `last_status` doubles as a claim
//      (`syncing`, a compare-and-set on the one row), a second sync is refused
//      as busy, and a claim older than ten minutes — a sync that died — is
//      taken over.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { parseICS, parseIcsDate } from '@/lib/sync/ics';
import { buildFeedRows, feedExternalUid, planFeedRows, seriesKeys } from '@/lib/calendar/feeds';

const mocks = vi.hoisted(() => ({ fetchPublicCalendarText: vi.fn() }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.fetchPublicCalendarText }));

import { BUSY_MESSAGE, CLAIM_STALE_MS, SYNCING_STATUS, syncFeed } from '@/lib/server/calendar-feeds';

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
const MASTER_OFF = [...MASTER, 'STATUS:CANCELLED'];
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
    const { rows, cancelled, cancelledSeries } = planFeedRows(parseICS(ics(MASTER, CANCELLED_WEEK)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['series']);
    expect(cancelled).toEqual(['series\u001F2026-09-19T14:00:00.000Z']);
    expect(cancelledSeries).toEqual([]);
  });

  it('a cancelled master is a removal of the whole series, not of its bare key', () => {
    const { rows, cancelled, cancelledSeries } = planFeedRows(parseICS(ics(MASTER_OFF, CONCERT)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['concert']);
    expect(cancelled).toEqual([]);
    expect(cancelledSeries).toEqual(['series']);
  });

  it.each([
    ['the master first', [MASTER_OFF, MOVED, CANCELLED_WEEK, CONCERT]],
    ['the master last', [MOVED, CANCELLED_WEEK, CONCERT, MASTER_OFF]],
  ])('a cancelled master takes the exceptions published beside it, and a cancelled occurrence of its own is not a separate removal (%s)', (_label, order) => {
    const { rows, cancelled, cancelledSeries } = planFeedRows(parseICS(ics(...order)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['concert']);
    expect(cancelled).toEqual([]);
    expect(cancelledSeries).toEqual(['series']);
  });

  it('a master published live after its cancellation is live again, exceptions and all', () => {
    const { rows, cancelled, cancelledSeries } = planFeedRows(parseICS(ics(MASTER_OFF, MASTER, MOVED)), FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid).sort()).toEqual(['series', MOVED_KEY].sort());
    expect(cancelled).toEqual([]);
    expect(cancelledSeries).toEqual([]);
  });

  it('seriesKeys takes the master and its exceptions from the stored keys, and nothing that merely begins the same way', () => {
    const stored = ['series', MOVED_KEY, 'series\u001F2026-09-19T14:00:00.000Z', 'series2', LOOKALIKE_UID, 'concert', 'concert\u001F2026-09-20T18:00:00.000Z'];
    expect(seriesKeys(stored, ['series'])).toEqual(['series', MOVED_KEY, 'series\u001F2026-09-19T14:00:00.000Z']);
    expect(seriesKeys(stored, ['concert'])).toEqual(['concert', 'concert\u001F2026-09-20T18:00:00.000Z']);
    expect(seriesKeys(stored, ['nothing'])).toEqual([]);
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
    // Not `.sort()` against an array holding `expect.any(String)`: the new row's
    // id is a random uuid, and where it sorts relative to 'ev-…' depends on its
    // first character, so that comparison failed about one run in eight.
    const ids = db.table('calendar_events').map((r) => r.id as string);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(['ev-manual', 'ev-other-feed']));
    expect(ids).not.toContain('ev-concert');
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

  // Second review on #908 (5972372165): the first fix stripped every control
  // character, HTAB included — and RFC 5545 admits HTAB in TEXT, so two legal
  // UIDs that differ only by an interior tab were one key.
  it('two UIDs that differ only by an interior tab are two events, live and cancelled, in either order', async () => {
    const TABBED = ['UID:club\tnight', 'SUMMARY:Club night', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z'];
    const PLAIN = ['UID:clubnight', 'SUMMARY:Plain night', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z'];
    reachable(ics(TABBED, PLAIN));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 2 });
    expect(feedEvents().map((r) => [r.external_uid, r.title]).sort()).toEqual([['club\tnight', 'Club night'], ['clubnight', 'Plain night']]);

    // Cancelling the tabbed one removes the tabbed one only, whichever is published first.
    for (const order of [[[...TABBED, 'STATUS:CANCELLED'], PLAIN], [PLAIN, [...TABBED, 'STATUS:CANCELLED']]]) {
      reachable(ics(...order));
      expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
      expect(feedEvents().map((r) => r.external_uid)).toEqual(['clubnight']);
      reachable(ics(TABBED, PLAIN));
      await syncFeed(client(), FEED);
    }
  });

  it('a previously imported UID carrying a tab is updated in place, not duplicated under a stripped key', async () => {
    db.seed('calendar_events', [{ id: 'ev-tabbed', family_id: FAMILY, feed_id: FEED.id, external_uid: 'club\tnight', title: 'Club night (old title)', starts_at: '2026-09-12T19:00:00.000Z', recurrence: 'none' }]);
    reachable(ics(['UID:club\tnight', 'SUMMARY:Club night', 'DTSTART:20260912T190000Z', 'DTEND:20260912T200000Z']));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
    expect(feedEvents()).toHaveLength(1);
    expect(feedEvents()[0]).toMatchObject({ id: 'ev-tabbed', external_uid: 'club\tnight', title: 'Club night' });
    // A separator-carrying UID (illegal ICS) is still stripped; a tab is not a separator.
    expect(feedExternalUid({ uid: 'a\tb', recurrenceId: null })).toBe('a\tb');
    expect(feedExternalUid({ uid: 'a\u001Fb', recurrenceId: null })).toBe('ab');
    expect(feedExternalUid({ uid: 'a\tb', recurrenceId: '2026-09-12T14:00:00.000Z' })).toBe('a\tb\u001F2026-09-12T14:00:00.000Z');
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

  // Review on #908 (5976737100): the removal matched exact keys and the plan
  // named only the bare UID, so the moved and cancelled occurrences an earlier
  // sync had imported outlived their cancelled series.
  it.each([
    ['the exceptions are no longer published', [MASTER_OFF, CONCERT]],
    ['the exceptions are still published beside the cancelled master', [MASTER_OFF, MOVED, CANCELLED_WEEK, CONCERT]],
  ])('a cancelled master removes the exceptions an earlier sync imported, and nothing else (%s)', async (_label, vevents) => {
    db.seed('calendar_events', [
      { id: 'ev-master', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Soccer practice', starts_at: '2026-09-05T14:00:00.000Z', recurrence: 'weekly' },
      { id: 'ev-moved', family_id: FAMILY, feed_id: FEED.id, external_uid: MOVED_KEY, title: 'Soccer practice (moved)', starts_at: '2026-09-13T10:00:00.000Z', recurrence: 'none' },
      { id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' },
      // Begins with the series' UID; is not the series.
      { id: 'ev-series2', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series2', title: 'Second series', starts_at: '2026-09-06T14:00:00.000Z', recurrence: 'weekly' },
      // The same exception key under ANOTHER feed: not this feed's to touch.
      { id: 'ev-other-feed', family_id: FAMILY, feed_id: 'feed-2', external_uid: MOVED_KEY, title: 'Other club (moved)', starts_at: '2026-09-13T10:00:00.000Z', recurrence: 'none' },
    ]);
    reachable(ics(...vevents));
    const result = await syncFeed(client(), FEED);
    expect(result).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.external_uid).sort()).toEqual(['concert', 'series2']);
    expect(db.table('calendar_events').find((r) => r.id === 'ev-other-feed'), "the other feed's row").toBeDefined();
    expect(feedRow()).toMatchObject({ last_status: 'ok', last_error: null, event_count: 1 });
  });

  it('a refused read of the stored keys is reported and stamped, not swallowed as a clean sync', async () => {
    db.seed('calendar_events', [{ id: 'ev-moved', family_id: FAMILY, feed_id: FEED.id, external_uid: MOVED_KEY, title: 'Soccer practice (moved)', starts_at: '2026-09-13T10:00:00.000Z', recurrence: 'none' }]);
    reachable(ics(MASTER_OFF));
    const refused = { code: '42501', message: 'permission denied for table calendar_events' };
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown>;
          if (table === 'calendar_events') {
            builder.select = () => {
              const chain: Record<string, unknown> = {};
              Object.assign(chain, { eq: () => chain, order: () => chain, range: () => chain, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: refused }) });
              return chain;
            };
          }
          return builder;
        };
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await syncFeed(flaky as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: false, error: 'Could not read calendar events' });
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'Could not read calendar events' });
    expect(db.table('calendar_events').find((r) => r.id === 'ev-moved'), 'nothing was removed').toBeDefined();
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
    // A cancelled series is resolved to exact stored keys, never a pattern.
    expect(removal).not.toContain('.like(');
    expect(src).toContain('seriesKeys(');
  });
});

// Review on #908 (5976737100): the nightly cron and a member's "Sync now" ran
// the same feed at once, and nothing ordered their writes. The one holding the
// OLDER snapshot could delete what the newer one had just written, or write
// back what it had just removed.
describe('one sync of a feed at a time', () => {
  let db: InMemorySupabase;
  const client = () => db as unknown as SupabaseClient<Database>;
  const feedEvents = () => db.table('calendar_events').filter((r) => r.feed_id === FEED.id) as Row[];
  const feedRow = () => db.table('calendar_feeds').find((r) => r.id === FEED.id) as Row;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const snapshot = (...vevents: string[][]) => ({ ok: true as const, url: FEED.url, text: ics(...vevents) });

  beforeEach(() => {
    db = createInMemorySupabase({ uniques: { calendar_events: [['feed_id', 'external_uid']] } });
    db.seed('calendar_feeds', [{ ...FEED, name: 'Team', last_status: 'ok', last_error: null, last_synced_at: '2026-09-01T00:00:00.000Z', event_count: 1, updated_at: '2026-09-01T00:00:00.000Z' }]);
    db.seed('calendar_events', [{ id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' }]);
    mocks.fetchPublicCalendarText.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('a second sync while one is in flight is refused as busy and writes nothing; the newer snapshot is applied after the older one, not under it', async () => {
    // Sync A is waiting on the network for the OLDER snapshot (the concert
    // cancelled) when sync B arrives for the newer one (the concert back on).
    let publish!: (value: ReturnType<typeof snapshot>) => void;
    mocks.fetchPublicCalendarText.mockImplementationOnce(() => new Promise((resolve) => { publish = resolve; }));
    const a = syncFeed(client(), FEED);
    await tick();
    expect(feedRow().last_status).toBe(SYNCING_STATUS);
    expect(mocks.fetchPublicCalendarText).toHaveBeenCalledTimes(1);

    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(MASTER, CONCERT));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: BUSY_MESSAGE, busy: true });
    expect(mocks.fetchPublicCalendarText, 'the refused sync fetched nothing').toHaveBeenCalledTimes(1);
    expect(feedEvents().map((r) => r.external_uid), 'and wrote nothing').toEqual(['concert']);

    publish(snapshot(MASTER, CONCERT_OFF));
    expect(await a).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.external_uid)).toEqual(['series']);
    expect(feedRow()).toMatchObject({ last_status: 'ok', last_error: null });

    // B's snapshot, now that A has released the feed: the newer state stands
    // because it is applied last, not by the luck of an interleaving.
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 2 });
    expect(feedEvents().map((r) => r.external_uid).sort()).toEqual(['concert', 'series']);
  });

  it('a claim older than ten minutes is a sync that died, and is taken over; a fresh one is not', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(CONCERT));
    Object.assign(feedRow(), { last_status: SYNCING_STATUS, updated_at: minutesAgo(1) });
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: BUSY_MESSAGE, busy: true });
    expect(feedRow().last_status).toBe(SYNCING_STATUS);

    Object.assign(feedRow(), { last_status: SYNCING_STATUS, updated_at: minutesAgo(CLAIM_STALE_MS / 60_000 + 1) });
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
    expect(feedRow()).toMatchObject({ last_status: 'ok', last_error: null });
  });

  it('a sync that throws releases the claim as an error rather than holding the feed for ten minutes', async () => {
    mocks.fetchPublicCalendarText.mockRejectedValueOnce(new Error('Synthetic transport failure'));
    await expect(syncFeed(client(), FEED)).rejects.toThrow('Synthetic transport failure');
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'The sync did not finish' });
    // And the next sync is not refused.
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(CONCERT));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
  });

  it('an ordinary failed exit releases the claim too: a failed fetch, a non-calendar', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValueOnce({ ok: false, error: 'Synthetic provider failure' });
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: 'Synthetic provider failure' });
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'Synthetic provider failure' });
    mocks.fetchPublicCalendarText.mockResolvedValueOnce({ ok: true, url: FEED.url, text: '<html>not a calendar</html>' });
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: 'URL is not a valid ICS calendar' });
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'URL is not a valid ICS calendar' });
  });

  it('claims with a compare-and-set on the one row, and the cron does not count a busy feed as a failure', () => {
    const src = readFileSync(join(ROOT, 'lib/server/calendar-feeds.ts'), 'utf8');
    expect(src).toContain(".update(mark).eq('id', feedId).neq('last_status', SYNCING_STATUS).select('id')");
    expect(src).toContain(".eq('last_status', SYNCING_STATUS).lt('updated_at', cutoff).select('id')");
    const cron = readFileSync(join(ROOT, 'app/api/cron/calendar-feeds/route.ts'), 'utf8');
    expect(cron).toContain('else if (r.busy) busy += 1;');
  });
});
