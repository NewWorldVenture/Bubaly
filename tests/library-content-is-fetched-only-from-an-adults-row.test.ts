// N18 — the library's "an adult adds what every child streams" rule lived only
// in subscribeFeedAction and addBookAction. library_feeds and library_items are
// `for all using is_family_member` (0284), so a child could insert a book with
// any audio address, or a feed with any feed_url, over PostgREST; and the three
// places that FETCH — the media proxy, Refresh and the nightly cron, which
// ingests with the service client — honoured whatever row they found, streaming
// it to every member from Bubaly's own origin.
//
// Each of the three now asks who added the row (lib/library/curator.ts). Driven
// for real against the in-memory database. A row with NO writer recorded is
// still played and refreshed: 0284 nulls created_by when the subscriber's
// account is deleted, and that feed keeps its episodes (S20 in
// tests/the-family-library-keeps-every-book-and-asks-a-grown-up.test.ts). The
// durable rule is a database trigger, which is the owner's migration.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const NOT_AN_ADULTS = 'This subscription was not added by a parent or another adult, so Bubaly does not refresh it. Ask one of them to subscribe to it.';

const h = vi.hoisted(() => ({ db: null as unknown, user: 'user-parent', role: 'parent', openPublicMedia: vi.fn(), fetchPublicFeed: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: h.user }, active: { familyId: 'fam-lib', role: h.role, member: { id: `m-${h.role}` } } }),
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

const { GET: media } = await import('@/app/library/media/[itemId]/route');
const { refreshFeedAction } = await import('@/app/(app)/dashboard/library/actions');
const { GET: nightly } = await import('@/app/api/cron/library-feeds/route');
const { NextRequest } = await import('next/server');

const FAMILY = 'fam-lib';
const FEED_XML = '<rss><channel><title>Show</title><item><guid>ep-1</guid><title>One</title><enclosure url="https://cdn.test/1.mp3"/></item></channel></rss>';
let db: InMemorySupabase;

const play = (itemId: string) => media(new NextRequest(`https://bubaly.test/library/media/${itemId}`), { params: Promise.resolve({ itemId }) });
const as = (user: string, role: string) => { h.user = user; h.role = role; };
const audio = () => ({ status: 200 as const, headers: { 'content-type': 'audio/mpeg' }, body: Readable.from([Buffer.from('bytes')]), close: vi.fn() });

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  as('user-parent', 'parent');
  h.openPublicMedia.mockReset().mockImplementation(async () => audio());
  h.fetchPublicFeed.mockReset().mockImplementation(async (url: string) => ({ url, text: FEED_XML }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', is_active: true, display_name: 'Ada' },
    { id: 'm-child', family_id: FAMILY, user_id: 'user-child', role: 'child', is_active: true, display_name: 'Kit' },
  ]);
  db.seed('library_feeds', [
    { id: 'feed-parent', family_id: FAMILY, kind: 'podcast', title: 'Parent show', feed_url: 'https://parent.test/feed', created_by: 'user-parent', last_fetched_at: '2026-10-12T00:00:00Z', last_error: null },
    // Written by the child over PostgREST, past both actions.
    { id: 'feed-child', family_id: FAMILY, kind: 'podcast', title: 'Planted', feed_url: 'https://planted.test/feed', created_by: 'user-child', last_fetched_at: null, last_error: null },
  ]);
  db.seed('library_items', [
    { id: 'book-parent', family_id: FAMILY, feed_id: null, kind: 'book', guid: 'manual:a', title: 'A parent\'s audiobook', media_url: 'https://cdn.test/book.mp3', created_by: 'user-parent' },
    { id: 'book-child', family_id: FAMILY, feed_id: null, kind: 'book', guid: 'manual:b', title: 'Planted', media_url: 'https://planted.test/a.mp3', created_by: 'user-child' },
    { id: 'ep-parent', family_id: FAMILY, feed_id: 'feed-parent', kind: 'episode', guid: 'p1', title: 'Episode', media_url: 'https://cdn.test/ep.mp3', created_by: null },
    { id: 'ep-child', family_id: FAMILY, feed_id: 'feed-child', kind: 'episode', guid: 'c1', title: 'Planted episode', media_url: 'https://planted.test/ep.mp3', created_by: null },
  ]);
});

describe('the media route streams only what an adult put in the library', () => {
  it.each(['parent', 'child'])('a %s is not served a book a child planted, or an episode of a feed a child planted', async (role) => {
    as(`user-${role}`, role);
    expect((await play('book-child')).status).toBe(403);
    expect((await play('ep-child')).status).toBe(403);
    expect(h.openPublicMedia).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'])('a %s still plays a parent\'s book and a parent\'s feed', async (role) => {
    as(`user-${role}`, role);
    expect((await play('book-parent')).status).toBe(200);
    expect((await play('ep-parent')).status).toBe(200);
  });

  it('a row naming a member who has since become a guest is not served', async () => {
    db.table('family_members').find((m) => m.user_id === 'user-parent')!.role = 'guest';
    expect((await play('book-parent')).status).toBe(403);
  });
});

describe('Refresh fetches only a feed an adult subscribed to', () => {
  it('a child pressing Refresh on a feed they planted fetches nothing', async () => {
    as('user-child', 'child');
    expect(await refreshFeedAction('feed-child')).toEqual({ ok: false, error: NOT_AN_ADULTS });
    expect(h.fetchPublicFeed).not.toHaveBeenCalled();
  });

  it('anyone still refreshes what a parent subscribed to', async () => {
    as('user-child', 'child');
    expect((await refreshFeedAction('feed-parent')).ok).toBe(true);
    expect(h.fetchPublicFeed).toHaveBeenCalledWith('https://parent.test/feed');
  });
});

describe('the nightly cron fetches only feeds an adult subscribed to', () => {
  it('skips the planted feed, says why on it, and moves it to the back of the queue', async () => {
    const response = await nightly(new NextRequest('https://bubaly.test/api/cron/library-feeds'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ refreshed: 1, skipped: 1, failed: 0 });
    expect(h.fetchPublicFeed.mock.calls.map((c) => c[0])).toEqual(['https://parent.test/feed']);
    const planted = db.table('library_feeds').find((f) => f.id === 'feed-child')!;
    expect(planted.last_error).toBe(NOT_AN_ADULTS);
    expect(planted.last_fetched_at).toEqual(expect.any(String));
    expect(translate(MESSAGES, 'library.feedNotAddedByAnAdult')).toBe(NOT_AN_ADULTS);
  });
});
