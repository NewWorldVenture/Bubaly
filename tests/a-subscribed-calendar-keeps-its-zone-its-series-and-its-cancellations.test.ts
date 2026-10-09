// These tests verify initial source date resolution, distinct master/exception
// rows, explicit cancellation cleanup and atomic claim fencing. They do not
// certify publisher-zone recurrence, complete RRULE semantics or suppression of
// the master's original moved/cancelled slot: those need durable model changes.
//
// Production feed admission now refuses timed rules and all exception sets;
// pure parser/planner checks below describe their shape, not import support.
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
// Now: supported explicit IANA TZID is resolved by the strict shared ICS clock;
// unsupported zones and referenced supplied VTIMEZONE definitions are refused.
// An exception is stored under the UID joined
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

import { APPLY_SYNC_FUNCTION, BUSY_MESSAGE, CLAIM_STALE_MS, SYNCING_STATUS, TAKEN_OVER_MESSAGE, resetApplySyncWarningForTests, syncAllFeedsForFamily, syncFeed } from '@/lib/server/calendar-feeds';

const ROOT = join(__dirname, '..');
const FAMILY = 'fam-1';
const FEED = { id: 'feed-1', family_id: FAMILY, url: 'https://club.example/team.ics' };

/**
 * 0490's `calendar_feed_apply_sync`, as the fake runs it: the fence is checked
 * and the chunk written in one step, with nothing between them. Upserts land on
 * (feed_id, external_uid) like the real conflict target; removals are this
 * feed's rows under the named keys.
 */
const applySyncFunction = (args: Record<string, unknown>, db: InMemorySupabase): string => {
  const feed = db.table('calendar_feeds').find((r) => r.id === args.p_feed_id);
  if (!feed || feed.last_status !== SYNCING_STATUS || feed.updated_at !== args.p_fence) return 'lost';
  const events = db.table('calendar_events');
  for (const row of (args.p_upserts as Row[]) ?? []) {
    const existing = events.find((r) => r.feed_id === args.p_feed_id && r.external_uid === row.external_uid);
    if (existing) Object.assign(existing, row);
    else events.push(db.withDefaults('calendar_events', { ...row, feed_id: args.p_feed_id }));
  }
  const removals = new Set((args.p_removals as string[]) ?? []);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].feed_id === args.p_feed_id && removals.has(events[i].external_uid as string)) events.splice(i, 1);
  }
  return 'applied';
};

/** A VCALENDAR from VEVENT bodies, CRLF-terminated as a server would send it. */
const ics = (...vevents: string[][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//club//EN',
  ...vevents.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']),
  'END:VCALENDAR', '',
].join('\r\n');

const ALL_DAY_MASTER = ['UID:series', 'SUMMARY:Soccer practice', 'DTSTART;VALUE=DATE:20260905', 'RRULE:FREQ=WEEKLY'];
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
/** A CANCEL as RFC 5546 §3.2.5 allows it: the identity of the occurrence, nothing else. */
const BARE_CANCELLED_WEEK = ['UID:series', 'RECURRENCE-ID:20260919T140000Z', 'STATUS:CANCELLED'];
/** The whole series cancelled by its bare UID. */
const BARE_MASTER_OFF = ['UID:series', 'STATUS:CANCELLED'];

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

  // RFC 5545 §3.3.5 on DST nights: a reading the zone skips takes the offset in
  // force BEFORE the gap; a reading it shows twice is the FIRST instant.
  it('reads a reading the zone skips at spring-forward with the offset in force before the gap', () => {
    // New York jumps from 02:00 to 03:00 on 2026-03-08; 02:30 never happens.
    // 02:30 at EST's -5 is 07:30Z (shown as 03:30 EDT), not 03:00's 07:00Z.
    expect(parseIcsDate('20260308T023000', 'America/New_York').iso).toBe('2026-03-08T07:30:00.000Z');
    expect(parseIcsDate('20260308T023000', 'America/Chicago').iso).toBe('2026-03-08T08:30:00.000Z');
    expect(parseIcsDate('20261004T023000', 'Australia/Sydney').iso).toBe('2026-10-03T16:30:00.000Z');
  });

  it('reads a reading the zone shows twice at fall-back as the first instant', () => {
    expect(parseIcsDate('20261025T013000', 'Europe/London').iso).toBe('2026-10-25T00:30:00.000Z');
    expect(parseIcsDate('20261101T013000', 'America/New_York').iso).toBe('2026-11-01T05:30:00.000Z');
    expect(parseIcsDate('20260405T023000', 'Australia/Sydney').iso).toBe('2026-04-04T15:30:00.000Z');
  });

  it('keeps the seconds of a zoned reading', () => {
    expect(parseIcsDate('20260906T090015', 'America/New_York').iso).toBe('2026-09-06T13:00:15.000Z');
  });

  it('refuses unknown explicit zones, including quoted parameters containing a colon', () => {
    expect(() => parseICS(ics(['UID:o', 'SUMMARY:Standup', 'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260906T090000']))).toThrow();
    expect(() => parseIcsDate('20260906T090000', 'Eastern Standard Time')).toThrow();
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

  // Review 5981467749 on #908: RFC 5546 §3.2.5 lets a CANCEL carry only the
  // identity of what it cancels. The parser dropped such a component for want
  // of DTSTART and SUMMARY, and the plan skipped it for want of a start, so a
  // minimal, valid cancellation left the imported occurrence (or series) in
  // place. The sync parses with `bareCancellations`; the other readers do not.
  it('a cancellation that carries only its identity cancels the occurrence it names, or the whole series when it names the master', () => {
    const events = parseICS(ics(MASTER, BARE_CANCELLED_WEEK), { bareCancellations: true });
    expect(byUid(events, 'series').map((e) => [e.status, e.recurrenceId, e.startsAt])).toEqual([
      [undefined, null, '2026-09-05T14:00:00.000Z'],
      ['cancelled', '2026-09-19T14:00:00.000Z', '2026-09-19T14:00:00.000Z'],
    ]);
    const { rows, cancelled, cancelledSeries } = planFeedRows(events, FAMILY, FEED.id);
    expect(rows.map((r) => r.external_uid)).toEqual(['series']);
    expect(cancelled).toEqual(['series\u001F2026-09-19T14:00:00.000Z']);
    expect(cancelledSeries).toEqual([]);

    const whole = planFeedRows(parseICS(ics(BARE_MASTER_OFF, CONCERT), { bareCancellations: true }), FAMILY, FEED.id);
    expect(whole.rows.map((r) => r.external_uid)).toEqual(['concert']);
    expect(whole.cancelled).toEqual([]);
    expect(whole.cancelledSeries).toEqual(['series']);
  });

  it('without the option a component that cannot be placed is still dropped, and a live event with no start never becomes a row', () => {
    expect(byUid(parseICS(ics(MASTER, BARE_CANCELLED_WEEK, BARE_MASTER_OFF)), 'series')).toHaveLength(1);
    const noStart = ['UID:floating', 'SUMMARY:No start'];
    expect(parseICS(ics(noStart), { bareCancellations: true })).toEqual([]);
    expect(planFeedRows([{ uid: 'floating', title: 'No start', startsAt: '' }], FAMILY, FEED.id).rows).toEqual([]);
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
      rpc: { [APPLY_SYNC_FUNCTION]: applySyncFunction },
    });
    db.seed('calendar_feeds', [{ ...FEED, name: 'Team', last_status: null, last_error: null, last_synced_at: null, event_count: 0 }]);
    mocks.fetchPublicCalendarText.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a moved exception rather than rewriting a previously collapsed series', async () => {
    db.seed('calendar_events', [{ id: 'ev-1', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Earlier imported event' }]);
    const before = structuredClone(feedEvents());
    reachable(ics(ALL_DAY_MASTER, MOVED, CONCERT));
    expect(await syncFeed(client(), FEED)).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported calendar recurrence') });
    expect(feedEvents()).toEqual(before);
    expect(feedRow()).toMatchObject({ last_status: 'error', event_count: 0 });
  });

  it('removes an event the source has since cancelled, and nothing else', async () => {
    db.seed('calendar_events', [
      { id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' },
      // The same uid under ANOTHER feed, and a family event of its own: neither is this feed's to touch.
      { id: 'ev-other-feed', family_id: FAMILY, feed_id: 'feed-2', external_uid: 'concert', title: 'Choir concert', starts_at: '2026-09-21T18:00:00.000Z', recurrence: 'none' },
      { id: 'ev-manual', family_id: FAMILY, feed_id: null, external_uid: null, title: 'Dentist', starts_at: '2026-09-22T09:00:00.000Z', recurrence: 'none' },
    ]);
    reachable(ics(ALL_DAY_MASTER, CONCERT_OFF));

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

  it('refuses a bare exception cancellation but still removes a bare cancelled master', async () => {
    db.seed('calendar_events', [
      { id: 'ev-master', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Soccer practice' },
      { id: 'ev-week', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series\u001F2026-09-19T14:00:00.000Z', title: 'Practice' },
      { id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Autumn concert' },
    ]);
    const before = structuredClone(feedEvents());
    reachable(ics(ALL_DAY_MASTER, BARE_CANCELLED_WEEK, CONCERT));
    expect(await syncFeed(client(), FEED)).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported calendar recurrence') });
    expect(feedEvents()).toEqual(before);
    reachable(ics(BARE_MASTER_OFF, CONCERT));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.id)).toEqual(['ev-concert']);
  });

  // Review 5971622223 on #908: under the old `uid#recurrenceId` key, a
  // stand-alone event whose UID happened to be `series#2026-09-12T14:00:00.000Z`
  // shared a key with the moved 12 September occurrence, so one of them was lost
  // in the plan — and when that occurrence was cancelled, the feed-scoped delete
  // took the stand-alone event with it.
  it('refuses the snapshot with a moved occurrence without importing its look-alike', async () => {
    reachable(ics(ALL_DAY_MASTER, MOVED, LOOKALIKE));
    expect(await syncFeed(client(), FEED)).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported calendar recurrence') });
    expect(feedEvents()).toEqual([]);
  });

  it.each([
    ['the cancelled occurrence before the look-alike', [ALL_DAY_MASTER, CANCELLED_MOVED_WEEK, LOOKALIKE]],
    ['the look-alike before the cancelled occurrence', [ALL_DAY_MASTER, LOOKALIKE, CANCELLED_MOVED_WEEK]],
  ])('cancelling the occurrence does not remove the look-alike, with %s', async (_order, vevents) => {
    // Imported on an earlier sync, under the bare UID every one-off is stored by.
    db.seed('calendar_events', [{ id: 'ev-lookalike', family_id: FAMILY, feed_id: FEED.id, external_uid: LOOKALIKE_UID, title: 'Unrelated talk', starts_at: '2026-09-12T18:00:00.000Z', recurrence: 'none' }]);
    reachable(ics(...vevents));
    const result = await syncFeed(client(), FEED);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported calendar recurrence') });
    expect(db.table('calendar_events').find((r) => r.id === 'ev-lookalike'), 'the stand-alone event survives the cancellation').toBeDefined();
    expect(feedEvents().map((r) => r.external_uid)).toEqual([LOOKALIKE_UID]);
    expect(feedRow()).toMatchObject({ last_status: 'error', event_count: 0 });
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
    const before = structuredClone(feedEvents());
    const result = await syncFeed(client(), FEED);
    if (vevents.includes(MOVED)) {
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported calendar recurrence') });
      expect(feedEvents()).toEqual(before);
      return;
    }
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
    reachable(ics(ALL_DAY_MASTER, CONCERT_OFF));
    const result = await syncFeed(client(), FEED);
    expect(result).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.external_uid)).toEqual(['series']);
    expect(feedRow().last_status).toBe('ok');
  });

  it('a refused atomic removal is stamped as a failed sync and leaves the event', async () => {
    db.seed('calendar_events', [{ id: 'ev-concert', family_id: FAMILY, feed_id: FEED.id, external_uid: 'concert', title: 'Concert', starts_at: '2026-09-20T18:00:00.000Z' }]);
    const options = db as unknown as { options: { rpc: Record<string, typeof applySyncFunction> } };
    options.options.rpc[APPLY_SYNC_FUNCTION] = (args, d) => {
      if ((args.p_removals as string[]).length) throw new Error('permission denied');
      return applySyncFunction(args, d);
    };
    reachable(ics(ALL_DAY_MASTER, CONCERT_OFF));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: 'Could not remove cancelled events' });
    expect(feedEvents().some(r => r.id === 'ev-concert')).toBe(true);
    expect(feedRow().last_status).toBe('error');
  });

  it('every event mutation goes through the atomic claim RPC, or — without 0490 only — the pre-0490 upsert', () => {
    const src = readFileSync(join(ROOT, 'lib/server/calendar-feeds.ts'), 'utf8');
    expect(src).toContain('supabase.rpc(APPLY_SYNC_FUNCTION');
    // Owner decision (2026-10-09): a database without held 0490 writes the way
    // production did before it. This asserted no `.upsert(` at all while a
    // missing RPC refused event writes; now the one upsert is the fallback's.
    expect(src.split('.upsert(')).toHaveLength(2);
    expect(src.indexOf('.upsert(')).toBeGreaterThan(src.indexOf('async function legacyApplyChunk('));
    expect(src).not.toContain('.delete()');
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
    // The primary path: 0490's function is in the database.
    db = createInMemorySupabase({ uniques: { calendar_events: [['feed_id', 'external_uid']] }, rpc: { [APPLY_SYNC_FUNCTION]: applySyncFunction } });
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

    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(ALL_DAY_MASTER, CONCERT));
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: BUSY_MESSAGE, busy: true });
    expect(mocks.fetchPublicCalendarText, 'the refused sync fetched nothing').toHaveBeenCalledTimes(1);
    expect(feedEvents().map((r) => r.external_uid), 'and wrote nothing').toEqual(['concert']);

    publish(snapshot(ALL_DAY_MASTER, CONCERT_OFF));
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

  // ── the claim is fenced (audit note of 2026-10-04 07:33 UTC) ────────────────
  const TAKEN_OVER = { ok: false, error: TAKEN_OVER_MESSAGE, takenOver: true };
  /** What another sync's stale takeover does to the row: the same mark, a newer stamp. */
  const takeOver = () => { const stamp = new Date(Date.now() + 1).toISOString(); Object.assign(feedRow(), { last_status: SYNCING_STATUS, updated_at: stamp }); return stamp; };

  it('a sync whose claim was taken over while it was on the network writes nothing and leaves the status to the new holder', async () => {
    let publish!: (value: ReturnType<typeof snapshot>) => void;
    mocks.fetchPublicCalendarText.mockImplementationOnce(() => new Promise((resolve) => { publish = resolve; }));
    const a = syncFeed(client(), FEED);
    await tick();
    const stamp = takeOver(); // ten minutes have passed for the row; another sync took the claim
    publish(snapshot(ALL_DAY_MASTER, CONCERT_OFF)); // A's snapshot would upsert the series and remove the concert
    expect(await a).toEqual(TAKEN_OVER);
    expect(feedEvents().map((r) => r.external_uid), 'nothing of A\'s reached the calendar').toEqual(['concert']);
    expect(feedRow(), 'the new holder\'s claim is untouched: no result, no "did not finish"').toMatchObject({ last_status: SYNCING_STATUS, updated_at: stamp });
  });

  it('a sync that lost its claim cannot stamp a failure over the new holder either', async () => {
    let publish!: (value: { ok: false; error: string }) => void;
    mocks.fetchPublicCalendarText.mockImplementationOnce(() => new Promise((resolve) => { publish = resolve; }));
    const a = syncFeed(client(), FEED);
    await tick();
    const stamp = takeOver();
    publish({ ok: false, error: 'Synthetic provider failure' });
    expect(await a).toEqual(TAKEN_OVER);
    expect(feedRow()).toMatchObject({ last_status: SYNCING_STATUS, last_error: null, updated_at: stamp });
  });

  it('a sync that lost its claim between its upsert and its removals stops there: what it upserted stands, nothing is removed, and the next sync settles the feed', async () => {
    // The takeover lands while A reads the stored keys for a cancelled series —
    // after its upsert, before its removals. A proxy performs it on that read.
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(CONCERT, MASTER_OFF));
    let stamp = '';
    const proxied = new Proxy(client(), {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = (target as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
          if (table !== 'calendar_events') return builder;
          return new Proxy(builder, {
            get(b, p, r) {
              const value = Reflect.get(b, p, r);
              if (p !== 'select' || typeof value !== 'function') return value;
              return (...args: unknown[]) => { if (args[0] === 'id, external_uid') stamp = takeOver(); return (value as (...a: unknown[]) => unknown).apply(b, args); };
            },
          });
        };
      },
    });
    db.seed('calendar_events', [{ id: 'ev-series', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Practice', starts_at: '2026-09-05T13:00:00.000Z', recurrence: 'weekly' }]);
    expect(await syncFeed(proxied as unknown as SupabaseClient<Database>, FEED)).toEqual(TAKEN_OVER);
    expect(feedEvents().map((r) => r.external_uid).sort(), 'the concert was upserted before the takeover; the cancelled series was NOT removed by the loser').toEqual(['concert', 'series']);
    expect(feedRow()).toMatchObject({ last_status: SYNCING_STATUS, updated_at: stamp });
    // The holder's own sync (here: the next one, once that claim is stale) applies the same snapshot and removes it.
    Object.assign(feedRow(), { updated_at: minutesAgo(CLAIM_STALE_MS / 60_000 + 1) });
    expect(await syncFeed(client(), FEED)).toEqual({ ok: true, imported: 1 });
    expect(feedEvents().map((r) => r.external_uid)).toEqual(['concert']);
    expect(feedRow()).toMatchObject({ last_status: 'ok' });
  });

  it('the cron counts a taken-over feed with the busy ones, and the add action does not roll back a feed another sync took over', () => {
    expect(readFileSync(join(ROOT, 'app/api/cron/calendar-feeds/route.ts'), 'utf8')).toContain('else if (r.busy || r.takenOver) busy += 1;');
    expect(readFileSync(join(ROOT, 'app/(app)/dashboard/sync/feeds/actions.ts'), 'utf8')).toContain('if (createdHere && !result.busy && !result.takenOver) {');
  });

  it('claims and stamps by compare-and-set and writes through the atomic function where it exists', () => {
    const src = readFileSync(join(ROOT, 'lib/server/calendar-feeds.ts'), 'utf8');
    expect(src).toContain(".eq('updated_at', fence)");
    expect(src).toContain('supabase.rpc(APPLY_SYNC_FUNCTION');
    // Owner decision (2026-10-09): was `not.toContain('.upsert(')`. The direct
    // upsert is reached only from the missing-0490 fallback (tests below).
    expect(src.indexOf('.upsert(')).toBeGreaterThan(src.indexOf('async function legacyApplyChunk('));
  });

  it('a sync whose claim is taken over between its fence check and its write (the window the function closes) writes nothing', async () => {
    // The takeover lands at the instant the function is entered — after any
    // check a client could have made, before the write. The function checks and
    // writes in one step, so the loser's chunk is refused whole.
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(ALL_DAY_MASTER, CONCERT_OFF));
    let stamp = '';
    let applies = 0;
    const racedDb = createInMemorySupabase({
      uniques: { calendar_events: [['feed_id', 'external_uid']] },
      rpc: { [APPLY_SYNC_FUNCTION]: (args, d) => { applies += 1; if (applies === 1) stamp = takeOver(); return applySyncFunction(args, d); } },
    });
    for (const table of ['calendar_feeds', 'calendar_events']) racedDb.replace(table, db.table(table));
    db = racedDb;
    expect(await syncFeed(client(), FEED)).toEqual(TAKEN_OVER);
    expect(applies, 'the loser asked once and stopped').toBe(1);
    expect(feedEvents().map((r) => r.external_uid), 'nothing of the loser\'s snapshot reached the calendar: no series, the concert still there').toEqual(['concert']);
    expect(feedRow(), 'the holder\'s claim is untouched').toMatchObject({ last_status: SYNCING_STATUS, updated_at: stamp });
  });

  it('a lost removal chunk is refused whole as well: the upserts before it stand, the removal does not happen', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(CONCERT, MASTER_OFF));
    db.seed('calendar_events', [{ id: 'ev-series', family_id: FAMILY, feed_id: FEED.id, external_uid: 'series', title: 'Practice', starts_at: '2026-09-05T13:00:00.000Z', recurrence: 'weekly' }]);
    let stamp = '';
    const handler = db as unknown as { options: { rpc: Record<string, typeof applySyncFunction> } };
    handler.options.rpc[APPLY_SYNC_FUNCTION] = (args, d) => { if ((args.p_removals as string[]).length > 0) stamp = takeOver(); return applySyncFunction(args, d); };
    expect(await syncFeed(client(), FEED)).toEqual(TAKEN_OVER);
    expect(feedEvents().map((r) => r.external_uid).sort()).toEqual(['concert', 'series']);
    expect(feedRow()).toMatchObject({ last_status: SYNCING_STATUS, updated_at: stamp });
  });

  it('a function that fails answers as a failed save, stamped on the feed', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValue(snapshot(CONCERT));
    const handler = db as unknown as { options: { rpc: Record<string, (args: Record<string, unknown>, d: InMemorySupabase) => unknown> } };
    handler.options.rpc[APPLY_SYNC_FUNCTION] = () => { throw new Error('Synthetic database failure'); };
    expect(await syncFeed(client(), FEED)).toEqual({ ok: false, error: 'Could not save calendar events' });
    expect(feedRow()).toMatchObject({ last_status: 'error', last_error: 'Could not save calendar events' });
  });
});

// Without 0490 the sync writes the way production did before it (owner
// decision, 2026-10-09; this block used to assert that writes fail closed): it
// upserts the live events, removes nothing the source cancelled, and checks its
// claim by reading the feed row before each chunk. Only the exact answer that
// `calendar_feed_apply_sync` is missing switches to that path; any other error
// is still a failed sync.
describe('without the held atomic function, events are written as before it', () => {
  beforeEach(() => { mocks.fetchPublicCalendarText.mockReset(); resetApplySyncWarningForTests(); });
  afterEach(() => vi.restoreAllMocks());

  type DbError = { code: string; message: string; details?: string | null; hint?: string | null };
  /** A database without 0490: the RPC answers `answer`; `before` runs first (a takeover, say). */
  const withoutApplySync = (answer: DbError, before?: (db: InMemorySupabase) => void) => {
    const db = createInMemorySupabase({ uniques: { calendar_events: [['feed_id', 'external_uid']] } });
    db.seed('calendar_feeds', [{ ...FEED, name: 'Team', last_status: 'ok', last_error: null, last_synced_at: '2026-09-01T00:00:00.000Z', event_count: 1, updated_at: '2026-09-01T00:00:00.000Z' }]);
    db.seed('calendar_events', [{ id: 'old', feed_id: FEED.id, family_id: FAMILY, external_uid: 'concert', title: 'Concert', starts_at: '2026-09-20T18:00:00.000Z', recurrence: 'none' }]);
    const calls: string[] = [];
    vi.spyOn(db, 'rpc').mockImplementation((async (name: string) => {
      calls.push(name);
      before?.(db);
      return { data: null, error: answer, count: null, status: 404, statusText: 'Not Found' };
    }) as never);
    return { db, calls, client: db as unknown as SupabaseClient<Database> };
  };
  // The answers PostgREST and Postgres give for exactly this function.
  const PGRST202: DbError = {
    code: 'PGRST202',
    message: `Could not find the function public.${APPLY_SYNC_FUNCTION}(p_fence, p_feed_id, p_removals, p_upserts) in the schema cache`,
    details: `Searched for the function public.${APPLY_SYNC_FUNCTION} with parameters p_fence, p_feed_id, p_removals, p_upserts or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
    hint: null,
  };
  const UNDEFINED_FUNCTION: DbError = { code: '42883', message: `function public.${APPLY_SYNC_FUNCTION}(uuid, timestamp with time zone, jsonb, text[]) does not exist` };
  const NAMED_IN_DETAILS_ONLY: DbError = { code: 'PGRST202', message: 'Could not find the function in the schema cache', details: `Searched for the function public.${APPLY_SYNC_FUNCTION}`, hint: null };

  it.each([['PGRST202', PGRST202], ['42883', UNDEFINED_FUNCTION], ['PGRST202 naming it in details', NAMED_IN_DETAILS_ONLY]])('on %s, upserts the live events in place and stamps the feed synced', async (_code, missing) => {
    const { db, calls, client } = withoutApplySync(missing);
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text: ics(ALL_DAY_MASTER, CONCERT) });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await syncFeed(client, FEED)).toEqual({ ok: true, imported: 2 });
    const events = db.table('calendar_events');
    expect(events.map((r) => r.external_uid).sort()).toEqual(['concert', 'series']);
    const concert = events.find((r) => r.external_uid === 'concert')!;
    expect(concert, 'updated in place on (feed_id, external_uid), not duplicated').toMatchObject({ id: 'old', title: 'Autumn concert' });
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: 'ok', last_error: null, event_count: 2 });
    expect(calls, 'asked once in this sync, then wrote the pre-0490 way').toEqual([APPLY_SYNC_FUNCTION]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0][0])).toContain('0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql');
    // Warned once per process; the next sync asks again, so an applied 0490 is used at once.
    expect(await syncFeed(client, FEED)).toEqual({ ok: true, imported: 2 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([APPLY_SYNC_FUNCTION, APPLY_SYNC_FUNCTION]);
  });

  it.each([
    ['a cancelled event beside a live one', [ALL_DAY_MASTER, CONCERT_OFF], 1],
    ['a cancellation-only snapshot', [CONCERT_OFF], 0],
    ['a cancelled master', [CONCERT, MASTER_OFF], 1],
  ])('leaves stored events the source cancelled in place, as before 0490, and writes no cancellation as live: %s', async (_label, events, imported) => {
    const { db, client } = withoutApplySync(PGRST202);
    db.seed('calendar_events', [{ id: 'ev-series', feed_id: FEED.id, family_id: FAMILY, external_uid: 'series', title: 'Practice', starts_at: '2026-09-05T13:00:00.000Z', recurrence: 'weekly' }]);
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text: ics(...events) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await syncFeed(client, FEED)).toEqual({ ok: true, imported });
    const stored = db.table('calendar_events');
    expect(stored.map((r) => r.id)).toEqual(expect.arrayContaining(['old', 'ev-series']));
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.id === 'old')!.title, 'a cancelled concert is not rewritten').toBe(imported && events.includes(CONCERT) ? 'Autumn concert' : 'Concert');
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: 'ok', event_count: imported });
  });

  it('writes nothing, and stamps nothing, once the feed row shows another sync took the claim', async () => {
    let stamp = '';
    const { db, client } = withoutApplySync(PGRST202, (d) => {
      stamp = new Date(Date.now() + 60_000).toISOString();
      Object.assign(d.table('calendar_feeds')[0], { last_status: SYNCING_STATUS, updated_at: stamp });
    });
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text: ics(ALL_DAY_MASTER, CONCERT) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await syncFeed(client, FEED)).toEqual({ ok: false, error: TAKEN_OVER_MESSAGE, takenOver: true });
    expect(db.table('calendar_events').map((r) => r.id)).toEqual(['old']);
    expect(db.table('calendar_events')[0].title).toBe('Concert');
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: SYNCING_STATUS, updated_at: stamp });
  });

  it.each<[string, DbError]>([
    ['a permission error', { code: '42501', message: `permission denied for function ${APPLY_SYNC_FUNCTION}` }],
    ['a network failure', { code: '', message: 'TypeError: fetch failed' }],
    ['a constraint inside the function', { code: '23505', message: 'duplicate key value violates unique constraint "uq_calendar_events_feed_uid"' }],
    ['a missing helper the function calls', { code: '42883', message: 'function calendar_feed_private.validate_value(jsonb, text, text) does not exist' }],
    ['a missing function of another name', { code: 'PGRST202', message: `Could not find the function public.${APPLY_SYNC_FUNCTION}_v2(p_feed_id) in the schema cache`, hint: null }],
    ['a missing table answer naming it', { code: 'PGRST205', message: `Could not find the table 'public.${APPLY_SYNC_FUNCTION}' in the schema cache` }],
  ])('still fails on %s, writing nothing', async (_label, failure) => {
    const { db, client } = withoutApplySync(failure);
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text: ics(ALL_DAY_MASTER, CONCERT) });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await syncFeed(client, FEED)).toEqual({ ok: false, error: 'Could not save calendar events' });
    expect(db.table('calendar_events')).toEqual([expect.objectContaining({ id: 'old', title: 'Concert' })]);
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: 'error', last_error: 'Could not save calendar events', event_count: 1 });
    expect(warning).not.toHaveBeenCalled();
  });

  it('a refused fallback upsert is a failed sync, stamped on the feed', async () => {
    const { db, client } = withoutApplySync(PGRST202);
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, url: FEED.url, text: ics(ALL_DAY_MASTER, CONCERT) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realFrom = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = realFrom(table);
      if (table === 'calendar_events') {
        (builder as unknown as { upsert: unknown }).upsert = async () => ({ data: null, error: { code: '42501', message: 'permission denied for table calendar_events' } });
      }
      return builder;
    }) as never);
    expect(await syncFeed(client, FEED)).toEqual({ ok: false, error: 'Could not save calendar events' });
    expect(db.table('calendar_events')).toEqual([expect.objectContaining({ id: 'old', title: 'Concert' })]);
    expect(db.table('calendar_feeds')[0]).toMatchObject({ last_status: 'error', last_error: 'Could not save calendar events' });
  });
});

describe('feed collections are read whole under a smaller server cap', () => {
  beforeEach(() => mocks.fetchPublicCalendarText.mockReset());

  it('syncs every family feed and excludes feeds from another family', async () => {
    const db = createInMemorySupabase({ maxRows: 1, rpc: { [APPLY_SYNC_FUNCTION]: applySyncFunction } });
    db.seed('calendar_feeds', ['a', 'b', 'c'].map(id => ({ ...FEED, id, last_status: 'pending' })));
    db.table('calendar_feeds').push({ ...FEED, id: 'foreign', family_id: 'other-family', last_status: 'pending' });
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, text: ics(CONCERT) });
    expect(await syncAllFeedsForFamily(db as unknown as SupabaseClient<Database>, FAMILY)).toEqual({ feeds: 3, imported: 3 });
    expect(db.table('calendar_events').map(row => row.feed_id).sort()).toEqual(['a', 'b', 'c']);
    expect(db.table('calendar_feeds').find(row => row.id === 'foreign')?.last_status).toBe('pending');
  });

  it('removes every stored exception of a cancelled master across pages, preserving unrelated keys', async () => {
    const db = createInMemorySupabase({ maxRows: 1, rpc: { [APPLY_SYNC_FUNCTION]: applySyncFunction } });
    db.seed('calendar_feeds', [{ ...FEED, last_status: 'pending' }]);
    const keys = ['series', MOVED_KEY, 'series\u001F2026-09-19T14:00:00.000Z', 'series\u001F2026-09-26T14:00:00.000Z', 'unrelated'];
    db.seed('calendar_events', keys.map((external_uid, n) => ({ id: `stored-${n}`, family_id: FAMILY, feed_id: FEED.id, external_uid })));
    mocks.fetchPublicCalendarText.mockResolvedValue({ ok: true, text: ics(['UID:series', 'STATUS:CANCELLED']) });
    expect(await syncFeed(db as unknown as SupabaseClient<Database>, FEED)).toEqual({ ok: true, imported: 0 });
    expect(db.table('calendar_events').map(row => row.external_uid)).toEqual(['unrelated']);
  });
});
