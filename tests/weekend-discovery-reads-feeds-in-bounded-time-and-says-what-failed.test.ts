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

  it('a Ticketmaster event with a date and no time is placed the same way, in its own zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    vi.stubEnv('TICKETMASTER_API_KEY', 'tm-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ _embedded: { events: [{
      id: 'tm-fair', name: 'County fair', dates: { start: { localDate: '2026-10-17' }, timezone: 'America/Chicago' },
    }] } }), { status: 200, headers: { 'content-type': 'application/json' } })));

    expect((await search()).status).toBe(200);
    expect(db.table('weekend_events')[0]).toMatchObject({ title: 'County fair', starts_at: '2026-10-17T05:00:00Z', ends_at: '2026-10-18T05:00:00Z' });
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
  /** Eight feeds that each take 15 s: four start at once, the next four at 15 s. */
  function slowFeeds() {
    harness.feedDelayMs = 15_000;
    db.seed('weekend_feeds', Array.from({ length: 8 }, (_, i) => {
      const url = `https://feeds.example/slow-${i}.ics`;
      harness.feedText.set(url, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
      return feed(`slow-${i}`, 'ics', url);
    }));
  }

  it('answers at the 25 s deadline, with the feeds still reading left for the next search', async () => {
    vi.useFakeTimers();
    slowFeeds();
    let answered = false;
    const pending = search().then((res) => { answered = true; return res; });

    // Held clock: the first four answer at 15 s, the second four would at 30 s.
    await vi.advanceTimersByTimeAsync(25_500);

    expect(answered).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(4);
    expect(body.errors).toEqual({ feedsSkipped: 'Some of your saved local feeds were left for the next search.' });
    // The late four keep their place at the front of the next search's queue.
    const rows = db.table('weekend_feeds');
    expect(rows.filter((row) => row.last_fetched_at === null)).toHaveLength(4);
    expect(rows.filter((row) => row.last_status === 'ok')).toHaveLength(4);

    // A late answer is not merged in, nor written, after the reply.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.table('weekend_feeds').filter((row) => row.last_fetched_at === null)).toHaveLength(4);
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
