// The family library (/dashboard/library), its actions, its media route and its
// nightly cron, driven for real against an in-memory database capped at
// PostgREST's db-max-rows (1,000):
//
//   S2   one read of the 200 newest-published items was filled by any podcast
//        with 200 episodes; a book added by hand has no published_at, so every
//        book fell off: "No books yet", and gone from Saved and Carry on
//   S7   a failed read of the person's places was only logged — every item
//        looked unstarted, and nothing said so
//   S13  any member, a young child included, could subscribe to any feed or
//        attach any audio or video address, streamed to every child from
//        Bubaly's own origin
//   S20  the cron passed created_by '' for a feed whose subscriber's account was
//        gone, and '' is not a uuid: the upsert failed every night; and every
//        refresh rewrote the author of every existing episode
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type Row } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params);

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  openPublicMedia: vi.fn(),
  fetchPublicFeed: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-me' }, active: { familyId: 'family-1', role: h.role, member: { id: 'member-me' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { translate: tr } = await import('@/lib/i18n/translate');
  const { readFileSync: read } = await import('node:fs');
  const messages = JSON.parse(read('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/server/public-media-fetch', () => ({ openPublicMedia: h.openPublicMedia }));
vi.mock('@/lib/server/public-document-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/public-document-fetch')>()),
  fetchPublicFeed: h.fetchPublicFeed,
}));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));

const FAMILY = 'family-1';
const FEED = `<?xml version="1.0"?><rss><channel>
  <title>The Kitchen Table</title>
  <itunes:author>Bubaly</itunes:author>
  <item><guid>ep-1</guid><title>Episode one</title><enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/></item>
  <item><guid>ep-2</guid><title>Episode two</title><enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

/** `library_items.feed_key` is 0285's generated column, `coalesce(feed_id::text, 'manual')`. */
function withGeneratedFeedKey<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = (target as { from: (t: string) => Record<string, (...args: unknown[]) => unknown> }).from(table);
        if (table !== 'library_items') return builder;
        const upsert = builder.upsert.bind(builder);
        builder.upsert = (rows: unknown, options: unknown) =>
          upsert((Array.isArray(rows) ? rows : [rows]).map((row: Row) => ({ ...row, feed_key: row.feed_id ?? 'manual' })), options);
        return builder;
      };
    },
  });
}

let base: ReturnType<typeof createInMemorySupabase>;
let fault: ((table: string, calls: FaultCall[]) => { code?: string; message: string } | null) | null;

beforeEach(() => {
  base = createInMemorySupabase({ maxRows: 1000 });
  fault = null;
  h.db = withFaults(withGeneratedFeedKey(base), (table, calls) => fault?.(table, calls) ?? null);
  h.role = 'parent';
  h.openPublicMedia.mockReset();
  h.fetchPublicFeed.mockReset().mockResolvedValue({ url: 'https://example.com/feed.xml', text: FEED });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function renderLibrary(): Promise<string> {
  const { ToastProvider } = await import('@/components/ui/toast');
  const { default: Page } = await import('@/app/(app)/dashboard/library/page');
  return renderToStaticMarkup(createElement(ToastProvider, null, await Page()));
}
/** The text of the card whose heading is `title`. */
function card(html: string, title: string): string {
  const at = html.indexOf(`<h2 class="${title === 'Saved' || title === 'Carry on' ? 'mb-2 font-semibold' : 'font-semibold'}">${title}</h2>`);
  expect(at, `no "${title}" card`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('<h2', at + 10);
  return html.slice(at, end === -1 ? undefined : end);
}

function seedLibrary() {
  base.seed('library_feeds', [{ id: 'feed-1', family_id: FAMILY, kind: 'podcast', title: 'Big Show', feed_url: 'https://example.com/feed.xml', author: null, last_fetched_at: null, last_error: null, created_by: 'user-me' }]);
  // One podcast with 250 dated episodes.
  base.seed('library_items', Array.from({ length: 250 }, (_, i) => ({
    id: `ep-${String(i).padStart(4, '0')}`, family_id: FAMILY, feed_id: 'feed-1', kind: 'episode', guid: `g-${i}`,
    title: `Big Show #${i}`, author: null, media_url: `https://cdn.example.com/${i}.mp3`, page_url: null,
    duration_seconds: 3600, published_at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString(),
  })));
  // A book typed in by hand: no published_at, ever.
  base.seed('library_items', [{
    id: 'book-1', family_id: FAMILY, feed_id: null, kind: 'book', guid: 'manual:wonder', title: 'Wonder (audiobook)',
    author: 'R. J. Palacio', media_url: 'https://cdn.example.com/wonder.mp3', page_url: null, duration_seconds: 30_000,
    published_at: null, created_at: '2026-10-01T00:00:00Z',
  }]);
  base.seed('library_progress', [{ id: 'p-1', family_id: FAMILY, item_id: 'book-1', user_id: 'user-me', position_seconds: 7200, saved: true, offline: false, completed_at: null, updated_at: '2026-10-12T00:00:00Z' }]);
}

describe('S2 — a book is on the shelf however many episodes a podcast has', () => {
  it('the Books card, Saved and Carry on hold the hand-added book, and the Episodes badge counts them all', async () => {
    seedLibrary();
    const html = await renderLibrary();

    expect(card(html, 'Books')).toContain('Wonder (audiobook)');
    expect(html).not.toContain('No books yet');
    expect(card(html, 'Saved')).toContain('Wonder (audiobook)');
    expect(card(html, 'Carry on')).toContain('Wonder (audiobook)');
    expect(card(html, 'Episodes')).toContain('>250</span>');
    expect(html).toContain(t('library.showingNewestEpisodes', { shown: 40, total: 250 }));
  }, 30_000);
});

describe('S7 — a place that could not be read is said, not guessed', () => {
  it('the page says the places could not be loaded', async () => {
    seedLibrary();
    fault = (table) => (table === 'library_progress' ? { message: 'canceling statement due to statement timeout' } : null);
    const html = await renderLibrary();

    expect(html).toContain(t('library.placeCouldNotBeLoaded'));
    // The list still plays.
    expect(card(html, 'Books')).toContain('Wonder (audiobook)');
  }, 30_000);

  it('a page whose places were read says nothing of the kind', async () => {
    seedLibrary();
    expect(await renderLibrary()).not.toContain(t('library.placeCouldNotBeLoaded'));
  }, 30_000);
});

describe('S13 — content reaches every child\'s library only from a grown-up', () => {
  const form = (fields: Record<string, string>) => {
    const data = new Map(Object.entries(fields));
    return { get: (key: string) => data.get(key) ?? null } as unknown as FormData;
  };

  it.each(['child', 'teen', 'caregiver'])('a %s cannot subscribe the family to a feed', async (role) => {
    h.role = role;
    const { subscribeFeedAction } = await import('@/app/(app)/dashboard/library/actions');
    const result = await subscribeFeedAction(form({ url: 'https://example.com/feed.xml', kind: 'podcast' }));

    expect(result).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(base.table('library_feeds')).toEqual([]);
    expect(h.fetchPublicFeed).not.toHaveBeenCalled();
  });

  it.each(['parent', 'adult'])('a %s still can', async (role) => {
    h.role = role;
    const { subscribeFeedAction } = await import('@/app/(app)/dashboard/library/actions');
    const result = await subscribeFeedAction(form({ url: 'https://example.com/feed.xml', kind: 'podcast' }));

    expect(result.ok).toBe(true);
    expect(base.table('library_items').map((row) => row.guid)).toEqual(['ep-1', 'ep-2']);
  });

  it('a child cannot attach an audio or video address to a book, but can keep a title', async () => {
    h.role = 'child';
    const { addBookAction } = await import('@/app/(app)/dashboard/library/actions');

    expect(await addBookAction(form({ title: 'A film', mediaUrl: 'https://videos.example.com/film.mp4' })))
      .toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(base.table('library_items')).toEqual([]);

    expect((await addBookAction(form({ title: 'Charlotte\'s Web' }))).ok).toBe(true);
    expect(base.table('library_items')).toEqual([expect.objectContaining({ title: 'Charlotte\'s Web', media_url: null })]);
  });

  it('a child cannot remove the family\'s subscription', async () => {
    seedLibrary();
    h.role = 'child';
    const { unsubscribeFeedAction } = await import('@/app/(app)/dashboard/library/actions');
    expect(await unsubscribeFeedAction('feed-1')).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(base.table('library_feeds')).toHaveLength(1);
  });

  it('a child\'s page offers no feed form and no audio field; a parent\'s does', async () => {
    h.role = 'child';
    const kid = await renderLibrary();
    expect(kid).not.toContain('Follow a feed');
    expect(kid).not.toContain('name="mediaUrl"');
    expect(kid).toContain('name="title"');

    h.role = 'parent';
    const grownUp = await renderLibrary();
    expect(grownUp).toContain('Follow a feed');
    expect(grownUp).toContain('name="mediaUrl"');
  }, 30_000);

  describe('the media route plays no video to a child or a teen', () => {
    const upstream = (contentType: string) => ({
      status: 200 as const, headers: { 'content-type': contentType }, body: Readable.from([Buffer.from('bytes')]), close: vi.fn(),
    });
    async function fetchMedia() {
      // Added by a parent: a book that names no writer is not played at all
      // (tests/library-content-is-fetched-only-from-an-adults-row.test.ts).
      base.seed('family_members', [{ id: 'member-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', is_active: true }]);
      base.seed('library_items', [{ id: 'film-1', family_id: FAMILY, feed_id: null, kind: 'book', guid: 'manual:film', title: 'A film', media_url: 'https://videos.example.com/film.mp4', created_by: 'user-parent' }]);
      const { GET } = await import('@/app/library/media/[itemId]/route');
      const { NextRequest } = await import('next/server');
      return GET(new NextRequest('https://bubaly.test/library/media/film-1'), { params: Promise.resolve({ itemId: 'film-1' }) });
    }

    it.each(['child', 'teen'])('a %s is refused a video stream, and the upstream socket is closed', async (role) => {
      h.role = role;
      const video = upstream('video/mp4');
      h.openPublicMedia.mockResolvedValue(video);

      const response = await fetchMedia();
      expect(response.status).toBe(415);
      expect(video.close).toHaveBeenCalled();
    });

    // A body the publisher names only as bytes is sniffed by the browser's
    // player, a video included: a child or a teen gets what is named as audio.
    it.each(['child', 'teen'])('a %s is refused an unnamed octet stream, and the upstream socket is closed', async (role) => {
      h.role = role;
      const bytes = upstream('application/octet-stream');
      h.openPublicMedia.mockResolvedValue(bytes);

      const response = await fetchMedia();
      expect(response.status).toBe(415);
      expect(bytes.close).toHaveBeenCalled();
    });

    it('a parent still streams an unnamed octet stream', async () => {
      h.role = 'parent';
      h.openPublicMedia.mockResolvedValue(upstream('application/octet-stream'));
      expect((await fetchMedia()).status).toBe(200);
    });

    it('a child still streams audio, and a parent still streams video', async () => {
      h.role = 'child';
      h.openPublicMedia.mockResolvedValue(upstream('audio/mpeg'));
      expect((await fetchMedia()).status).toBe(200);

      base.reset();
      h.role = 'parent';
      h.openPublicMedia.mockResolvedValue(upstream('video/mp4'));
      expect((await fetchMedia()).status).toBe(200);
    });
  });
});

describe('S20 — a feed whose subscriber is gone still gets its new episodes', () => {
  /** Postgres refuses '' for a uuid column (22P02). */
  const uuidColumns = (table: string, calls: FaultCall[]) => {
    if (table !== 'library_items') return null;
    const written = calls.filter((call) => call.method === 'upsert' || call.method === 'insert')
      .flatMap((call) => (Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]]) as Row[]);
    return written.some((row) => row.created_by === '')
      ? { code: '22P02', message: 'invalid input syntax for type uuid: ""' } : null;
  };

  it('the nightly refresh ingests it, answers 200, and records no error on the feed', async () => {
    fault = uuidColumns;
    base.seed('families', [{ id: FAMILY, closed_at: null }]);
    // 0284: library_feeds.created_by ON DELETE SET NULL.
    base.seed('library_feeds', [{ id: 'feed-1', family_id: FAMILY, kind: 'podcast', title: 'Show', feed_url: 'https://example.com/feed.xml', created_by: null, last_fetched_at: null, last_error: null }]);
    const { GET } = await import('@/app/api/cron/library-feeds/route');
    const { NextRequest } = await import('next/server');

    const response = await GET(new NextRequest('https://bubaly.test/api/cron/library-feeds', { headers: { authorization: 'Bearer x' } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, refreshed: 1, failed: 0, added: 2 });
    expect(base.table('library_items').map((row) => row.guid).sort()).toEqual(['ep-1', 'ep-2']);
    expect(base.table('library_feeds')[0].last_error).toBeNull();
  });

  it('a refresh by another member does not make them the author of episodes already there', async () => {
    base.seed('library_items', [{ id: 'item-1', family_id: FAMILY, feed_id: 'feed-1', feed_key: 'feed-1', kind: 'episode', guid: 'ep-1', title: 'Old title', created_by: 'user-who-subscribed' }]);
    const { ingestFeed } = await import('@/lib/library/ingest');

    expect(await ingestFeed(h.db as never, FAMILY, 'user-who-refreshed', 'feed-1', 'https://example.com/feed.xml')).toEqual({ added: 2 });

    const existing = base.table('library_items').find((row) => row.guid === 'ep-1')!;
    expect(existing).toMatchObject({ title: 'Episode one', created_by: 'user-who-subscribed' });
  });
});
