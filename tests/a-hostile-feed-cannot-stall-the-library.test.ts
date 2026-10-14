// N5 — one hostile feed blocked the event loop for minutes and stalled the
// nightly library-feeds cron for every family.
//
// parseFeed found every tag with a lazy regular expression, `<item…>([\s\S]*?)
// <\/item>` and its siblings, which rescans to the end of the document from
// EVERY opener that has no closer. A body of `<item>` repeated with no
// `</item>` therefore cost time in the square of its size — measured, 200 KB
// took 2.5 s, and fetchPublicFeed admits 4 MB. The parse is synchronous, and
// ingestFeed stamped last_fetched_at only AFTER it, so a run killed at
// maxDuration left the feed at the head of the stalest-first queue and every
// later night died on it before reaching anyone else's subscriptions.
//
// The parser is driven on 4 MB hostile bodies of each shape that was quadratic,
// and the real cron route against the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, fetchPublicFeed: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/public-document-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/public-document-fetch')>()),
  fetchPublicFeed: h.fetchPublicFeed,
}));

const { parseFeed } = await import('@/lib/library/feed-parse');
const { GET: libraryFeeds } = await import('@/app/api/cron/library-feeds/route');
const { NextRequest } = await import('next/server');
const { MAX_DOCUMENT_BYTES } = await import('@/lib/ai/document-text');

/** `unit` repeated to fill the 4 MB fetchPublicFeed admits, after `head`. */
const fill = (head: string, unit: string, tail = '') =>
  head + unit.repeat(Math.floor((MAX_DOCUMENT_BYTES - head.length - tail.length) / unit.length)) + tail;

// Linear work on 4 MB is tens of milliseconds; the quadratic scans this
// replaces took on the order of a thousand SECONDS on the same input. The
// bound leaves room for a loaded CI machine and none for the old behaviour.
const BUDGET_MS = 1_500;

describe('the parser reads a 4 MB hostile body in linear time', () => {
  const NOW = new Date('2026-10-14T00:00:00Z');
  const cases: [string, string][] = [
    ['<item> repeated, never closed', fill('<rss><channel><title>Show</title>', '<item>')],
    ['<entry> repeated, never closed', fill('<feed><title>Show</title>', '<entry>')],
    ['<title> repeated, never closed, and no item', fill('<rss><channel>', '<title>')],
    ['a namespaced opener repeated, never closed', fill('<rss><channel>', '<itunes:title>')],
    ['<enclosure with no `>` inside one item', fill('<rss><channel><title>Show</title><item><title>t</title>', '<enclosure url="x" ', '</item>')],
    ['<link with no `>` inside one item', fill('<rss><channel><title>Show</title><item><guid>g</guid>', '<link ', '</item>')],
    ['`<` with no `>` inside a title', fill('<rss><channel><title>Show</title><item><title>', '<', '</title></item>')],
    ['CDATA openers with no close inside a title', fill('<rss><channel><title>', '<![CDATA[', '</title><item><guid>g</guid></item>')],
  ];

  it.each(cases)('%s', (_shape, body) => {
    expect(body.length).toBeGreaterThan(MAX_DOCUMENT_BYTES - 64);
    const started = performance.now();
    const feed = parseFeed(body, NOW);
    const elapsed = performance.now() - started;
    expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(BUDGET_MS);
    // And it is still a parser: whatever it returns is bounded.
    expect((feed?.items.length ?? 0)).toBeLessThanOrEqual(300);
  });

  it('still reads an ordinary feed exactly as before', () => {
    const feed = parseFeed(`<rss><channel><title>Show</title>
      <item><title>One</title><guid>g1</guid><enclosure url="https://cdn.test/1.mp3"/></item>
      <ITEM><TITLE>Two</TITLE><guid>g2</guid><media:content url="https://cdn.test/2.mp3"/></ITEM>
    </channel></rss>`, NOW)!;
    expect(feed.items.map((i) => [i.title, i.guid, i.mediaUrl])).toEqual([
      ['One', 'g1', 'https://cdn.test/1.mp3'],
      ['Two', 'g2', 'https://cdn.test/2.mp3'],
    ]);
  });
});

describe('the nightly cron claims a feed before it reads it', () => {
  const FAMILY = 'fam-feeds';
  const PARENT = 'user-parent';
  let db: InMemorySupabase;

  const FEED = '<rss><channel><title>Show</title><item><guid>g1</guid><title>One</title><enclosure url="https://cdn.test/1.mp3"/></item></channel></rss>';

  beforeEach(() => {
    db = createInMemorySupabase({ maxRows: 1000 });
    h.db = db;
    h.fetchPublicFeed.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.seed('families', [{ id: FAMILY, closed_at: null }]);
    db.seed('family_members', [{ id: 'm-parent', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, display_name: 'Ada' }]);
    db.seed('library_feeds', [
      // Subscribed and never fetched: the head of the queue.
      { id: 'feed-hostile', family_id: FAMILY, kind: 'podcast', title: 'Hostile', feed_url: 'https://hostile.test/feed', created_by: PARENT, last_fetched_at: null, last_error: null },
      { id: 'feed-ok', family_id: FAMILY, kind: 'podcast', title: 'Fine', feed_url: 'https://fine.test/feed', created_by: PARENT, last_fetched_at: '2026-10-13T03:00:00.000Z', last_error: null },
    ]);
  });

  const tick = () => libraryFeeds(new NextRequest('https://bubaly.test/api/cron/library-feeds'));

  it('a run that dies inside one feed leaves that feed at the back of the queue, not the front', async () => {
    // Night one: the hostile feed takes the run down — its read never returns.
    let stampedWhenRead: unknown = 'not read';
    h.fetchPublicFeed.mockImplementation((url: string) => {
      if (url !== 'https://hostile.test/feed') return Promise.resolve({ url, text: FEED });
      stampedWhenRead = db.table('library_feeds').find((f) => f.id === 'feed-hostile')!.last_fetched_at;
      return new Promise(() => {});
    });
    void tick();
    await vi.waitFor(() => expect(stampedWhenRead).not.toBe('not read'), { timeout: 10_000 });
    expect(stampedWhenRead, 'the feed was claimed before it was read').toEqual(expect.any(String));

    // Night two: every other family's feed comes first.
    h.fetchPublicFeed.mockReset().mockImplementation(async (url: string) => ({ url, text: FEED }));
    const response = await tick();
    expect(response.status).toBe(200);
    expect(h.fetchPublicFeed.mock.calls.map((c) => c[0])).toEqual(['https://fine.test/feed', 'https://hostile.test/feed']);
  });
});
