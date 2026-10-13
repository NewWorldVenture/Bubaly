import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// POST /api/weekend/discover, the REAL route, against an in-memory database,
// with the network replaced: provider responses through a stubbed `fetch`, a
// family's saved feeds through a scripted `fetchPublicCalendarText`.
//
//   S4   parseRSS scanned with lazy regexes that rescanned to the end of the
//        text from every unclosed `<item`: a feed of one megabyte of `<item`
//        blocked the event loop for about a minute, per feed, per search
//   S11  an all-day ICS event (DTSTART;VALUE=DATE) was stored at UTC midnight:
//        5 PM the evening before in California, and dropped from discovery
//        from 6 PM that evening
//   S13  a provider was counted as used BEFORE it was fetched, so a search
//        where every provider failed answered 200 "No events found"
//   S18  every saved feed was fetched at once, however many there were

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  timezone: 'America/Los_Angeles',
  feedText: new Map<string, string>(),
  inFlight: 0,
  peak: 0,
  fetched: [] as string[],
  feedDelayMs: 0,
  /** Feeds whose fetch never settles. */
  hang: new Set<string>(),
}));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: null },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1', family_id: 'family-1' }, family: { id: 'family-1', timezone: harness.timezone } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({
  fetchPublicCalendarText: async (url: string) => {
    harness.fetched.push(url);
    harness.inFlight += 1;
    harness.peak = Math.max(harness.peak, harness.inFlight);
    try {
      if (harness.hang.has(url)) await new Promise(() => {});
      if (harness.feedDelayMs) await new Promise((resolve) => setTimeout(resolve, harness.feedDelayMs));
      const text = harness.feedText.get(url);
      return text === undefined ? { ok: false, error: 'unreachable', status: 422 } : { ok: true, url, text };
    } finally {
      harness.inFlight -= 1;
    }
  },
}));

const { POST } = await import('@/app/api/weekend/discover/route');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  harness.db = db;
  harness.timezone = 'America/Los_Angeles';
  harness.feedText = new Map();
  harness.inFlight = 0;
  harness.peak = 0;
  harness.fetched = [];
  harness.feedDelayMs = 0;
  harness.hang = new Set();
  vi.stubEnv('TICKETMASTER_API_KEY', '');
  vi.stubEnv('SEATGEEK_CLIENT_ID', '');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const search = (body: Record<string, unknown> = { zip: '94110', radius: 25, days: 6 }) =>
  POST(new NextRequest('https://fixture.invalid/api/weekend/discover', { method: 'POST', body: JSON.stringify(body) }));

function feed(id: string, kind: 'ics' | 'rss', url: string, extra: Record<string, unknown> = {}) {
  return { id, family_id: FAMILY, label: `Feed ${id}`, url, kind, is_active: true, last_fetched_at: null, last_status: null, last_count: 0, ...extra };
}

describe('S4 — a hostile RSS feed is read in linear time', () => {
  const SIZE = 512 * 1024;

  it.each([
    ['a megabyte-scale run of unclosed <item', '<item'.repeat(SIZE / 5)],
    ['one item whose <title is never closed', `<rss><item>${'<title'.repeat(SIZE / 6)}</item></rss>`],
    ['one item full of CDATA openers and bare <', `<rss><item><title>x</title><description>${'<![CDATA[<'.repeat(SIZE / 10)}</description></item></rss>`],
    ['an Atom entry of <link tags with no href', `<feed><entry><title>x</title>${'<link '.repeat(SIZE / 6)}</entry></feed>`],
  ])('%s does not hold the request', async (_name, body) => {
    db.seed('weekend_feeds', [feed('hostile', 'rss', 'https://feeds.example/hostile.xml')]);
    harness.feedText.set('https://feeds.example/hostile.xml', body);

    const started = Date.now();
    const res = await search();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect([200, 502]).toContain(res.status);
  });

  it('still reads an ordinary feed, item by item', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-23T12:00:00Z'));
    db.seed('weekend_feeds', [feed('library', 'rss', 'https://feeds.example/library.xml')]);
    harness.feedText.set('https://feeds.example/library.xml', `<rss><channel>
      <item><title>Library Story Time</title><link>https://lib/e1</link><pubDate>Thu, 25 Jun 2026 15:00:00 GMT</pubDate><description><![CDATA[<p>Ages 3-5</p>]]></description></item>
      <ITEM><TITLE>Book Swap</TITLE><guid>swap-1</guid><pubDate>Fri, 26 Jun 2026 16:00:00 GMT</pubDate></ITEM>
    </channel></rss>`);

    const res = await search();

    expect(res.status).toBe(200);
    expect(db.table('weekend_events').map((row) => [row.title, row.description]).sort()).toEqual([
      ['Book Swap', null], ['Library Story Time', 'Ages 3-5'],
    ]);
  });
});

describe('S11 — an all-day event is a date where the family is', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:fair-1@library', 'SUMMARY:Library book fair', 'DTSTART;VALUE=DATE:20261017', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('on Friday evening in California, Saturday\'s all-day fair is found and filed under Saturday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Friday 16 October 2026, 7 PM Pacific.
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    db.seed('weekend_feeds', [feed('library', 'ics', 'https://feeds.example/library.ics')]);
    harness.feedText.set('https://feeds.example/library.ics', ICS);

    const res = await search();

    expect(res.status).toBe(200);
    const [fair] = db.table('weekend_events');
    expect(fair).toMatchObject({ title: 'Library book fair' });
    // Midnight to midnight, Pacific (PDT, UTC-7).
    expect(fair.starts_at).toBe('2026-10-17T07:00:00Z');
    expect(fair.ends_at).toBe('2026-10-18T07:00:00Z');
  });

  // A date with no time is a calendar date: the fair is on Saturday the 17th
  // for the family planning it, wherever the provider files the venue. It is
  // stored midnight to midnight in the FAMILY's zone, which is how the planner
  // files it under that day and calls it all day.
  function ticketmasterSays(event: Record<string, unknown>) {
    vi.stubEnv('TICKETMASTER_API_KEY', 'tm-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ _embedded: { events: [event] } }), { status: 200, headers: { 'content-type': 'application/json' } })));
  }

  it('a Ticketmaster event with a date and no time is on that date where the family is, whatever the venue\'s zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    ticketmasterSays({ id: 'tm-fair', name: 'County fair', dates: { start: { localDate: '2026-10-17' }, timezone: 'America/Chicago' } });

    expect((await search()).status).toBe(200);
    // Midnight to midnight, Pacific (PDT, UTC-7) — not Chicago's midnight, 10 PM Friday in California.
    expect(db.table('weekend_events')[0]).toMatchObject({ title: 'County fair', starts_at: '2026-10-17T07:00:00Z', ends_at: '2026-10-18T07:00:00Z' });
  });

  it('with no family zone on file, the venue\'s zone places it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    harness.timezone = '';
    ticketmasterSays({ id: 'tm-fair', name: 'County fair', dates: { start: { localDate: '2026-10-17' }, timezone: 'America/Chicago' } });

    expect((await search()).status).toBe(200);
    expect(db.table('weekend_events')[0]).toMatchObject({ starts_at: '2026-10-17T05:00:00Z', ends_at: '2026-10-18T05:00:00Z' });
  });

  it('control: a timed Ticketmaster event keeps its own instant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    // 6 PM in Chicago is 4 PM in California.
    ticketmasterSays({ id: 'tm-show', name: 'Evening show', dates: { start: { localDate: '2026-10-17', localTime: '18:00:00', dateTime: '2026-10-17T23:00:00Z' }, timezone: 'America/Chicago' } });

    expect((await search()).status).toBe(200);
    expect(db.table('weekend_events')[0]).toMatchObject({ title: 'Evening show', starts_at: '2026-10-17T23:00:00Z', ends_at: null });
  });

  it('is still found on the morning of its own day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Saturday 17 October, 11 AM Pacific.
    vi.setSystemTime(new Date('2026-10-17T18:00:00Z'));
    db.seed('weekend_feeds', [feed('library', 'ics', 'https://feeds.example/library.ics')]);
    harness.feedText.set('https://feeds.example/library.ics', ICS);

    expect((await search()).status).toBe(200);
    expect(db.table('weekend_events').map((row) => row.title)).toEqual(['Library book fair']);
  });
});

describe('S13 — a search where every source failed is not an empty weekend', () => {
  it('answers 502 with what failed, and records no search, when the only provider is down', async () => {
    vi.stubEnv('TICKETMASTER_API_KEY', 'tm-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })));

    const res = await search();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe(translate(SOURCE_MESSAGES, 'discover.eventSourcesUnreachable'));
    expect(body.errors).toEqual({ ticketmaster: 'HTTP 503' });
    expect(db.table('weekend_searches')).toEqual([]);
  });

  it('answers 200 with the failure named when one source answered and another did not', async () => {
    vi.stubEnv('TICKETMASTER_API_KEY', 'tm-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })));
    db.seed('weekend_feeds', [feed('library', 'ics', 'https://feeds.example/library.ics')]);
    harness.feedText.set('https://feeds.example/library.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');

    const res = await search();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toEqual(['feed:Feed library']);
    expect(body.errors).toEqual({ ticketmaster: 'HTTP 503' });
  });

  it('names a saved feed that did not answer, though another feed did', async () => {
    db.seed('weekend_feeds', [
      feed('library', 'ics', 'https://feeds.example/library.ics'),
      feed('gone', 'ics', 'https://feeds.example/gone.ics'),
    ]);
    harness.feedText.set('https://feeds.example/library.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');

    const res = await search();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toEqual(['feed:Feed library']);
    expect(body.errors).toEqual({ feedsFailed: 'Some of your saved local feeds could not be read.' });
    expect(db.table('weekend_feeds').find((row) => row.id === 'gone')).toMatchObject({ last_status: 'HTTP 422' });
  });

  it('control: every saved feed answering names nothing', async () => {
    db.seed('weekend_feeds', [feed('library', 'ics', 'https://feeds.example/library.ics')]);
    harness.feedText.set('https://feeds.example/library.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');

    const res = await search();

    expect(res.status).toBe(200);
    expect((await res.json()).errors).toEqual({});
  });

  it('with nothing configured at all, still says how to connect a source', async () => {
    const res = await search();
    expect(res.status).toBe(503);
    expect((await res.json()).needsConfig).toBe(true);
  });
});

describe('S18 — one search reads a bounded number of saved feeds, a few at a time', () => {
  it('fetches at most twelve, at most four at once, and says the rest were left', async () => {
    harness.feedDelayMs = 5;
    db.seed('weekend_feeds', Array.from({ length: 30 }, (_, i) => {
      const url = `https://feeds.example/${String(i).padStart(2, '0')}.ics`;
      harness.feedText.set(url, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
      return feed(`f-${String(i).padStart(2, '0')}`, 'ics', url);
    }));

    const res = await search();

    expect(res.status).toBe(200);
    expect(harness.fetched.length).toBeLessThanOrEqual(12);
    expect(harness.fetched.length).toBeGreaterThan(0);
    expect(harness.peak).toBeLessThanOrEqual(4);
    expect(Object.keys((await res.json()).errors)).toContain('feedsSkipped');
  });

  it('reads the feeds fetched longest ago first, so every feed gets its turn', async () => {
    db.seed('weekend_feeds', Array.from({ length: 14 }, (_, i) => {
      const url = `https://feeds.example/${String(i).padStart(2, '0')}.ics`;
      harness.feedText.set(url, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
      // Feeds 00 and 01 were read most recently; the rest earlier, in order.
      const last = i < 2 ? `2026-10-13T1${i}:00:00Z` : `2026-10-0${Math.min(9, i - 1)}T00:00:00Z`;
      return feed(`f-${String(i).padStart(2, '0')}`, 'ics', url, { last_fetched_at: last });
    }));

    await search();

    expect(harness.fetched).not.toContain('https://feeds.example/00.ics');
    expect(harness.fetched).not.toContain('https://feeds.example/01.ics');
  });
});

describe('S18 — the deadline ends the feed reads, not only their start', () => {
  /** A calendar with one timed event on Friday 16 October, inside the search window. */
  const calendarWith = (uid: string, title: string) => [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, 'DTSTART:20261016T180000Z', 'DTEND:20261016T200000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  /** Wednesday 14 October 2026, 11 AM Pacific. */
  const NOW = new Date('2026-10-14T18:00:00Z');

  /** Twelve feeds that each take 9 s, each with its own event: four at 0 s, four at 9 s, and four at 18 s that would answer at 27 s. */
  function slowFeeds() {
    harness.feedDelayMs = 9_000;
    db.seed('weekend_feeds', Array.from({ length: 12 }, (_, i) => {
      const id = `slow-${String(i).padStart(2, '0')}`;
      const url = `https://feeds.example/${id}.ics`;
      harness.feedText.set(url, calendarWith(`${id}@feeds`, `Event from ${id}`));
      return feed(id, 'ics', url);
    }));
  }

  it('answers at the 25 s deadline, with the feeds still reading left for the next search', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    slowFeeds();
    let answered = false;
    const pending = search().then((res) => { answered = true; return res; });

    // Held clock: eight answer by 18 s; the last four would at 27 s.
    await vi.advanceTimersByTimeAsync(25_500);

    expect(answered).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(8);
    expect(body.count).toBe(8);
    expect(body.errors).toEqual({ feedsSkipped: 'Some of your saved local feeds were left for the next search.' });
    // The late four keep their place at the front of the next search's queue.
    const late = (rows: Record<string, unknown>[]) => rows.filter((row) => ['slow-08', 'slow-09', 'slow-10', 'slow-11'].includes(row.id as string));
    expect(late(db.table('weekend_feeds')).map((row) => row.last_fetched_at)).toEqual([null, null, null, null]);
    expect(db.table('weekend_events')).toHaveLength(8);

    // Their answers arrive at 27 s, with an event each: none is merged in or written.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(db.table('weekend_events')).toHaveLength(8);
    expect(db.table('weekend_events').map((row) => row.title)).not.toContain('Event from slow-08');
    expect(late(db.table('weekend_feeds')).map((row) => row.last_fetched_at)).toEqual([null, null, null, null]);
  });

  it('a status write that never settles does not hold the reply past the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db.seed('weekend_feeds', [feed('quick', 'ics', 'https://feeds.example/quick.ics')]);
    harness.feedText.set('https://feeds.example/quick.ics', calendarWith('quick@feeds', 'Quick event'));
    const real = db;
    harness.db = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== 'from') return Reflect.get(target, key, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table !== 'weekend_feeds') return builder;
          return new Proxy(builder, {
            get(b, k, r) {
              if (k === 'update') return () => ({ eq: () => new Promise(() => {}) });
              const value = Reflect.get(b, k, r);
              return typeof value === 'function' ? value.bind(b) : value;
            },
          });
        };
      },
    });
    let answered = false;
    const pending = search().then((res) => { answered = true; return res; });

    await vi.advanceTimersByTimeAsync(25_500);

    expect(answered).toBe(true);
    const body = await (await pending).json();
    // Its events were read before the write hung: it counts as read, not skipped.
    expect(body.sources).toEqual(['feed:Feed quick']);
    expect(body.errors).toEqual({});
    expect(db.table('weekend_events').map((row) => row.title)).toEqual(['Quick event']);
  });

  it('four feeds that never answer do not starve a fifth, on this search or the next', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stuck = ['stuck-0', 'stuck-1', 'stuck-2', 'stuck-3'];
    db.seed('weekend_feeds', [
      // Never fetched, so first in the queue, and never answering.
      ...stuck.map((id) => {
        harness.hang.add(`https://feeds.example/${id}.ics`);
        return feed(id, 'ics', `https://feeds.example/${id}.ics`);
      }),
      // Read before, so behind them.
      feed('fast', 'ics', 'https://feeds.example/fast.ics', { last_fetched_at: '2026-10-01T00:00:00Z' }),
    ]);
    harness.feedText.set('https://feeds.example/fast.ics', calendarWith('fast@feeds', 'Fast event'));

    const first = search();
    await vi.advanceTimersByTimeAsync(25_500);
    const one = await (await first).json();

    expect(one.sources).toEqual(['feed:Feed fast']);
    expect(one.errors).toEqual({ feedsFailed: 'Some of your saved local feeds could not be read.' });
    // The four are recorded as tried, so they fall behind.
    expect(db.table('weekend_feeds').filter((row) => stuck.includes(row.id as string)).map((row) => row.last_status))
      .toEqual(['Timed out.', 'Timed out.', 'Timed out.', 'Timed out.']);

    vi.setSystemTime(new Date('2026-10-14T19:00:00Z'));
    const second = search();
    await vi.advanceTimersByTimeAsync(25_500);
    const two = await (await second).json();

    expect(two.sources).toEqual(['feed:Feed fast']);
  });

  it('control: feeds that answer inside the deadline are all read', async () => {
    vi.useFakeTimers();
    harness.feedDelayMs = 5_000;
    db.seed('weekend_feeds', Array.from({ length: 8 }, (_, i) => {
      const url = `https://feeds.example/quick-${i}.ics`;
      harness.feedText.set(url, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
      return feed(`quick-${i}`, 'ics', url);
    }));
    const pending = search();

    await vi.advanceTimersByTimeAsync(11_000);

    const body = await (await pending).json();
    expect(body.sources).toHaveLength(8);
    expect(body.errors).toEqual({});
  });
});

describe('S18 — a feed status write that throws does not end the search\'s other feeds', () => {
  it('reads all twelve feeds when every status write rejects', async () => {
    db.seed('weekend_feeds', Array.from({ length: 12 }, (_, i) => {
      const url = `https://feeds.example/${String(i).padStart(2, '0')}.ics`;
      harness.feedText.set(url, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
      return feed(`f-${String(i).padStart(2, '0')}`, 'ics', url);
    }));
    // The status UPDATE rejects (a dropped connection), rather than answering { error }.
    const real = db;
    harness.db = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== 'from') return Reflect.get(target, key, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table !== 'weekend_feeds') return builder;
          return new Proxy(builder, {
            get(b, k, r) {
              if (k === 'update') return () => ({ eq: () => Promise.reject(new Error('connection reset')) });
              const value = Reflect.get(b, k, r);
              return typeof value === 'function' ? value.bind(b) : value;
            },
          });
        };
      },
    });

    const res = await search();

    expect(res.status).toBe(200);
    expect(harness.fetched).toHaveLength(12);
    const body = await res.json();
    expect(body.sources).toHaveLength(12);
    expect(body.errors).toEqual({});
  });
});
