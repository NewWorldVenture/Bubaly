import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type FaultCall, type Row } from './helpers/in-memory-supabase';
import { decodeEntities, parseFeed } from '@/lib/library/feed-parse';

const h = vi.hoisted(() => ({
  db: null as unknown, familyId: 'family-feed',
  fetchPublicFeed: vi.fn(), revalidatePath: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-parent' }, active: { familyId: h.familyId, role: 'parent' } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/public-document-fetch', () => ({ fetchPublicFeed: h.fetchPublicFeed }));
// Isolate the advisory process-local limiter: these tests exercise parsing and
// real action/curator/ingest calls, not elapsed-time or rate-limit enforcement.
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: h.rateLimit }));
const { refreshFeedAction } = await import('@/app/(app)/dashboard/library/actions');
const { FEED_UNREADABLE, FEED_NOT_A_FEED, FEED_SAVE_FAILED } = await import('@/lib/library/ingest');

const FAMILY = 'family-feed', FEED = 'feed-one', URL = 'https://publisher.test/feed';
const NOW = new Date('2026-10-16T00:00:00Z');
const episode = (guid: string, title: string) => `<item><guid>${guid}</guid><title>${title}</title><enclosure url="https://cdn.test/${guid}.mp3"/></item>`;
const rss = (title: string) => `<rss><channel><title>Show</title>${episode('one', title)}${episode('two', 'Healthy sibling')}</channel></rss>`;
const overflows = ['&#1114112;', '&#x110000;', '&#X110000;', '&#xFFFFFFFF;', '&#999999999999999999999;', '&#0001114112;'];

describe('numeric feed entities stay inside the JavaScript conversion range', () => {
  it.each(overflows)('preserves unsupported spelling %s without throwing or dropping adjacent text', token => {
    expect(decodeEntities(`Before ${token} after &amp; &#65;`)).toBe(`Before ${token} after & A`);
  });

  it.each([
    ['&#65;', 'A'], ['&#x41;', 'A'], ['&#X0041;', 'A'], ['&#128512;', '😀'], ['&#x1F600;', '😀'],
    ['&#1114111;', '\u{10ffff}'], ['&#X10FFFF;', '\u{10ffff}'], ['&#0;', '&#0;'],
    ['&unknown;', '&unknown;'], ['&#-1; &#xno; &#65', '&#-1; &#xno; &#65'],
    [`&#${'9'.repeat(400)};`, `&#${'9'.repeat(400)};`],
    [`&#x${'F'.repeat(400)};`, `&#x${'F'.repeat(400)};`],
    ['&#55296;', '\uD800'],
  ])('keeps the existing supported or unrecognised result for %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});

describe('the complete feed survives one unsupported numeric entity', () => {
  it.each(['channel title', 'item title', 'item description', 'Atom summary'])('preserves healthy entries through %s', location => {
    const token = '&#X110000;';
    const xml = location === 'Atom summary'
      ? `<feed><title>Show</title><entry><id>one</id><title>First</title><summary>Notes ${token}</summary><link rel="enclosure" href="https://cdn.test/one.mp3"/></entry><entry><id>two</id><title>Healthy sibling</title><link rel="enclosure" href="https://cdn.test/two.mp3"/></entry></feed>`
      : `<rss><channel><title>${location === 'channel title' ? `Show ${token}` : 'Show'}</title><item><guid>one</guid><title>${location === 'item title' ? `First ${token}` : 'First'}</title><description>${location === 'item description' ? `Notes ${token}` : 'Notes'}</description><enclosure url="https://cdn.test/one.mp3"/></item>${episode('two', 'Healthy sibling')}</channel></rss>`;
    const parsed = parseFeed(xml, NOW);
    expect(parsed?.items.map(item => [item.guid, item.title, item.mediaUrl])).toEqual([
      ['one', location === 'item title' ? `First ${token}` : 'First', 'https://cdn.test/one.mp3'],
      ['two', 'Healthy sibling', 'https://cdn.test/two.mp3'],
    ]);
    expect(location === 'channel title' ? parsed?.title : location === 'item title' ? parsed?.items[0].title : parsed?.items[0].description)
      .toContain(token);
  });

  it('reads a consumed Atom rel attribute without turning an unknown relation into an enclosure', () => {
    const parsed = parseFeed('<feed><title>Show</title><entry><id>one</id><title>First</title><link rel="enclosure&#X110000;" href="https://cdn.test/wrong.mp3"/><link rel="alternate" href="https://publisher.test/one"/></entry></feed>', NOW);
    expect(parsed?.items).toMatchObject([{ guid: 'one', mediaUrl: null, pageUrl: 'https://publisher.test/one' }]);
  });

  it('still decodes a supported entity in a consumed enclosure relation', () => {
    const parsed = parseFeed('<feed><title>Show</title><entry><id>one</id><title>First</title><link rel="&#X0065;nclosure" href="https://cdn.test/one.mp3"/></entry></feed>', NOW);
    expect(parsed?.items).toMatchObject([{ guid: 'one', mediaUrl: 'https://cdn.test/one.mp3' }]);
  });
});

describe('actual Refresh retains healthy sibling episodes', () => {
  let base: ReturnType<typeof createInMemorySupabase>;
  let writes: { table: string; call: FaultCall }[];
  let refuseItems: boolean;
  let unexpectedFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    base = createInMemorySupabase({ maxRows: 1000 });
    h.familyId = FAMILY;
    writes = []; refuseItems = false;
    base.seed('family_members', [{ id: 'member-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', is_active: true }]);
    base.seed('library_feeds', [{ id: FEED, family_id: FAMILY, feed_url: URL, title: 'Old title', created_by: 'user-parent', last_error: 'Old failure', last_fetched_at: null }]);
    // Only model0285's generated conflict key; keep actual builder filters,
    // update/upsert execution and refusal behavior in the shared strict helper.
    const generated = new Proxy(base, {
      get(target, key, receiver) {
        if (key !== 'from') return Reflect.get(target, key, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table === 'library_items') {
            const upsert = builder.upsert.bind(builder);
            builder.upsert = (rows, options) => upsert((Array.isArray(rows) ? rows : [rows]).map(row => ({ ...row, feed_key: row.feed_id ?? 'manual' })), options);
          }
          return builder;
        };
      },
    });
    h.db = withFaults(generated, (table, calls) => {
      for (const call of calls.filter(call => ['update', 'upsert', 'insert', 'delete'].includes(call.method))) writes.push({ table, call });
      return refuseItems && table === 'library_items' && calls.some(call => call.method === 'upsert') ? { code: '42501', message: 'Item write refused' } : null;
    });
    h.rateLimit.mockReset().mockReturnValue({ ok: true });
    h.revalidatePath.mockReset();
    h.fetchPublicFeed.mockReset().mockResolvedValue({ url: URL, text: rss('First &amp; ordinary') });
    unexpectedFetch = vi.fn(() => { throw new Error('Unexpected external fetch'); });
    vi.stubGlobal('fetch', unexpectedFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    try { expect(unexpectedFetch).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });

  const itemWrites = () => writes.filter(write => write.table === 'library_items');
  const stored = () => base.table('library_items').map(row => ({ guid: row.guid, title: row.title, family_id: row.family_id, feed_id: row.feed_id, feed_key: row.feed_key }));
  const expected = (title: string) => [
    { guid: 'one', title, family_id: FAMILY, feed_id: FEED, feed_key: FEED },
    { guid: 'two', title: 'Healthy sibling', family_id: FAMILY, feed_id: FEED, feed_key: FEED },
  ];

  it.each(['&#1114112;', '&#X110000;'])('actually saves both episodes when the first title contains %s', async token => {
    h.fetchPublicFeed.mockResolvedValue({ url: URL, text: rss(`First ${token}`) });
    const result = await refreshFeedAction(FEED);
    // Joint observation: the original is a real action refusal with ZERO item
    // writes/rows, not merely an unobserved decoder exception or mock mismatch.
    expect({ result, rows: stored(), itemWriteAttempts: itemWrites().length }).toEqual({
      result: { ok: true, message: 'Refreshed. 2 items up to date.' }, rows: expected(`First ${token}`), itemWriteAttempts: 1,
    });
    expect(base.table('library_feeds')[0]).toMatchObject({ title: 'Show', last_error: null, last_fetched_at: expect.any(String) });
    expect(h.fetchPublicFeed.mock.calls).toEqual([[URL]]);
    expect(h.revalidatePath.mock.calls).toEqual([['/dashboard/library']]);
    expect(h.rateLimit.mock.calls.map(call => call[0])).toEqual([`library-refresh-feed:${FEED}`, `library-refresh-family:${FAMILY}`]);
  });

  it('does not duplicate preserved entries on a second ordinary refresh', async () => {
    h.fetchPublicFeed.mockResolvedValue({ url: URL, text: rss('First &#x110000;') });
    expect(await refreshFeedAction(FEED)).toMatchObject({ ok: true });
    expect(await refreshFeedAction(FEED)).toMatchObject({ ok: true });
    expect(stored()).toEqual(expected('First &#x110000;'));
    expect(itemWrites()).toHaveLength(2);
  });

  it('keeps ordinary refresh and decoded title behavior', async () => {
    expect(await refreshFeedAction(FEED)).toEqual({ ok: true, message: 'Refreshed. 2 items up to date.' });
    expect(stored()).toEqual(expected('First & ordinary'));
    expect(itemWrites()).toHaveLength(1);
  });

  it.each(['fetch failure', 'not a feed'])('keeps %s visible with no item writes', async fault => {
    if (fault === 'fetch failure') h.fetchPublicFeed.mockRejectedValue(new Error('Publisher unavailable'));
    else h.fetchPublicFeed.mockResolvedValue({ url: URL, text: 'Not markup' });
    const error = fault === 'fetch failure' ? FEED_UNREADABLE : FEED_NOT_A_FEED;
    expect(await refreshFeedAction(FEED)).toEqual({ ok: false, error });
    expect(stored()).toEqual([]); expect(itemWrites()).toEqual([]);
    expect(base.table('library_feeds')[0]).toMatchObject({ title: 'Old title', last_error: error });
  });

  it.each(['wrong family', 'non-curator'])('still refuses %s before any publisher fetch', async fault => {
    if (fault === 'wrong family') h.familyId = 'other-family';
    else (base.table('family_members')[0] as Row).role = 'child';
    expect(await refreshFeedAction(FEED)).toMatchObject({ ok: false });
    expect(h.fetchPublicFeed).not.toHaveBeenCalled(); expect(writes).toEqual([]); expect(stored()).toEqual([]);
  });

  it('keeps an item-save refusal after the already successful metadata update', async () => {
    refuseItems = true;
    expect(await refreshFeedAction(FEED)).toEqual({ ok: false, error: FEED_SAVE_FAILED });
    expect(stored()).toEqual([]); expect(itemWrites()).toHaveLength(1);
    expect(base.table('library_feeds')[0]).toMatchObject({ title: 'Show', last_error: FEED_SAVE_FAILED, last_fetched_at: expect.any(String) });
    expect(writes.map(write => [write.table, write.call.method])).toEqual([['library_feeds', 'update'], ['library_items', 'upsert'], ['library_feeds', 'update']]);
  });

  it('retains the action refusal when the isolated rate-limit boundary refuses', async () => {
    h.rateLimit.mockReturnValue({ ok: false });
    expect(await refreshFeedAction(FEED)).toEqual({ ok: false, error: 'That feed was just refreshed. Give it a few minutes.' });
    expect(h.fetchPublicFeed).not.toHaveBeenCalled(); expect(writes).toEqual([]); expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
