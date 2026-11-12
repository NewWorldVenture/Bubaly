// Call-level role tests for app/(app)/dashboard/library/actions.ts
// (Register B: ACTION-B3F17CEDFF9B subscribeFeedAction, ACTION-F3AC8A6C2E1D
// refreshFeedAction, ACTION-E69528A3174C unsubscribeFeedAction,
// ACTION-BFAA74E0C4FE addBookAction, ACTION-86DDF0156A9D saveProgressAction).
//
// THE POLICY, from the sources rather than from the action:
//   - Curating (subscribing, removing a subscription, attaching an audio
//     address) is a parent's or adult's: the action's refuseUnlessCurator
//     comment, lib/library/curator.ts, and the page, which offers the feed form,
//     Remove and media upload only when `isManager` (library/page.tsx:59, :223,
//     :244-252).
//   - Refresh is anyone's but a guest's: page.tsx:223 `canRefresh = role !==
//     'guest'`; 0481 puts 0464's guest-write trigger on library_feeds and
//     library_items (ROLE-M03: a guest views the library and does not change it).
//   - A bookmark (library_progress) is each person's own row: 0284's policy is
//     `is_family_member(family_id) and user_id = auth.uid()`, with no guest guard.
// An id from another family is refused and changes nothing in either family.
//
// NOT PINNED HERE: addBookAction (title only) for a guest. The action has no
// guest gate and writes the book; 0481's trigger on library_items says a guest
// does not write it. Reported as a defect in the PR, not committed as failing.
//
// Driven: the REAL actions, ingest and curator check against the in-memory
// PostgREST fake. Stubbed: the session, the client factory, the translator
// (key in, key out), the in-memory rate limiter, and fetchPublicFeed — the one
// network seam, stubbed the way tests/a-library-refresh-keeps-the-callers-
// write-boundary.test.ts stubs it — so subscribe and refresh reach success.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  db: null as unknown, role: 'parent', revalidatePath: vi.fn(), fetchFeed: vi.fn(), outbound: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${mocks.role}`, email: `${mocks.role}@example.com` },
    memberships: [],
    active: { familyId: 'family-a', role: mocks.role, member: { id: `member-${mocks.role}` }, family: { id: 'family-a', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/public-document-fetch', () => ({ fetchPublicFeed: mocks.fetchFeed }));

const {
  subscribeFeedAction, refreshFeedAction, unsubscribeFeedAction, addBookAction, saveProgressAction,
} = await import('@/app/(app)/dashboard/library/actions');

const A = 'family-a';
const B = 'family-b';
const FEED_A = '00000000-0000-4000-8000-00000000a010';
const FEED_A_BY_CHILD = '00000000-0000-4000-8000-00000000a011';
const FEED_B = '00000000-0000-4000-8000-00000000b010';
const ITEM_A = '00000000-0000-4000-8000-00000000a020';
const ITEM_B = '00000000-0000-4000-8000-00000000b020';
const FEED_URL = 'https://podcast.example.com/feed.xml';
const NEW_URL = 'https://new.example.com/feed.xml';
const XML = '<rss><channel><title>Example Show</title><item><guid>ep-1</guid><title>One</title><enclosure url="https://podcast.example.com/one.mp3"/></item></channel></rss>';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const MANAGERS = ['parent', 'adult'] as const;
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;
const MEMBERS_NOT_GUEST = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;
const NOT_ALLOWED = { ok: false, error: 'actionRefusal.notAllowed' };

let db: InMemorySupabase;
const as = (role: string) => { mocks.role = role; };
const state = () => structuredClone({
  feeds: db.table('library_feeds'), items: db.table('library_items'), progress: db.table('library_progress'),
});
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { library_feeds: [['family_id', 'feed_url']], library_progress: [['item_id', 'user_id']] } });
  mocks.db = db;
  mocks.fetchFeed.mockImplementation(async (url: string) => ({ url, text: XML }));
  vi.stubGlobal('fetch', mocks.outbound.mockImplementation(() => { throw new Error('unexpected outbound fetch'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: `member-${role}`, family_id: A, user_id: `user-${role}`, role, is_active: true })),
    { id: 'member-b-parent', family_id: B, user_id: 'user-b-parent', role: 'parent', is_active: true },
  ]);
  db.seed('library_feeds', [
    { id: FEED_A, family_id: A, kind: 'podcast', title: 'A show', feed_url: FEED_URL, created_by: 'user-parent' },
    { id: FEED_A_BY_CHILD, family_id: A, kind: 'podcast', title: 'Planted', feed_url: 'https://planted.example.com/feed.xml', created_by: 'user-child' },
    { id: FEED_B, family_id: B, kind: 'podcast', title: 'B show', feed_url: FEED_URL, created_by: 'user-b-parent' },
  ]);
  db.seed('library_items', [
    { id: ITEM_A, family_id: A, feed_id: null, kind: 'book', guid: 'manual:a', title: 'A book', created_by: 'user-parent' },
    { id: ITEM_B, family_id: B, feed_id: null, kind: 'book', guid: 'manual:b', title: 'B book', created_by: 'user-b-parent' },
  ]);
  as('parent');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('subscribeFeedAction', () => {
  it.each(MANAGERS)("ACTION-B3F17CEDFF9B a %s subscribes: one feed row and its episodes, in their own family", async (role) => {
    as(role);
    const result = await subscribeFeedAction(form({ url: NEW_URL, kind: 'podcast' }));
    expect(result).toEqual({ ok: true, message: 'Subscribed. 1 item added.' });
    const feed = db.table('library_feeds').filter((f) => f.feed_url === NEW_URL);
    expect(feed).toEqual([expect.objectContaining({ family_id: A, created_by: `user-${role}`, title: 'Example Show' })]);
    expect(db.table('library_items').filter((i) => i.feed_id === feed[0].id))
      .toEqual([expect.objectContaining({ family_id: A, guid: 'ep-1', kind: 'episode' })]);
    expect(mocks.fetchFeed).toHaveBeenCalledWith(NEW_URL);
  });

  it.each(NON_MANAGERS)('ACTION-B3F17CEDFF9B a %s is refused before anything is fetched or written', async (role) => {
    as(role);
    const before = state();
    expect(await subscribeFeedAction(form({ url: NEW_URL, kind: 'podcast' }))).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
    expect(mocks.fetchFeed).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-B3F17CEDFF9B a parent subscribing to the address family B follows gets A's own row; B's feed is untouched", async () => {
    const bBefore = structuredClone(db.table('library_feeds').find((f) => f.id === FEED_B));
    db.replace('library_feeds', db.table('library_feeds').filter((f) => f.id !== FEED_A));
    expect(await subscribeFeedAction(form({ url: FEED_URL, kind: 'podcast' }))).toMatchObject({ ok: true });
    const forUrl = db.table('library_feeds').filter((f) => f.feed_url === FEED_URL);
    expect(forUrl.map((f) => f.family_id).sort()).toEqual([A, B]);
    expect(db.table('library_feeds').find((f) => f.id === FEED_B)).toEqual(bBefore);
    expect(db.table('library_items').filter((i) => i.family_id === B)).toEqual([expect.objectContaining({ id: ITEM_B })]);
  });
});

describe('refreshFeedAction', () => {
  it.each(MEMBERS_NOT_GUEST)("ACTION-F3AC8A6C2E1D a %s refreshes an adult's feed: its episodes land in their family", async (role) => {
    as(role);
    expect(await refreshFeedAction(FEED_A)).toEqual({ ok: true, message: 'Refreshed. 1 item up to date.' });
    expect(db.table('library_items').filter((i) => i.feed_id === FEED_A))
      .toEqual([expect.objectContaining({ family_id: A, guid: 'ep-1' })]);
    expect(db.table('library_feeds').find((f) => f.id === FEED_A)).toMatchObject({ title: 'Example Show', last_error: null });
    expect(db.table('library_feeds').find((f) => f.id === FEED_B)).toMatchObject({ title: 'B show' });
  });

  it('ACTION-F3AC8A6C2E1D a guest is refused before anything is read, fetched or written', async () => {
    as('guest');
    const before = state();
    expect(await refreshFeedAction(FEED_A)).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
    expect(mocks.fetchFeed).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'])("ACTION-F3AC8A6C2E1D a %s naming family B's feed is told it is not found; nothing is fetched and neither family changes", async (role) => {
    as(role);
    const before = state();
    expect(await refreshFeedAction(FEED_B)).toEqual({ ok: false, error: 'That subscription could not be found.' });
    expect(state()).toEqual(before);
    expect(mocks.fetchFeed).not.toHaveBeenCalled();
  });

  it('ACTION-F3AC8A6C2E1D a feed no adult added is not fetched, even for a parent', async () => {
    const before = state();
    expect(await refreshFeedAction(FEED_A_BY_CHILD)).toEqual({ ok: false, error: 'library.feedNotAddedByAnAdult' });
    expect(state()).toEqual(before);
    expect(mocks.fetchFeed).not.toHaveBeenCalled();
  });
});

describe('unsubscribeFeedAction', () => {
  it.each(MANAGERS)("ACTION-E69528A3174C a %s removes their family's subscription and only that row", async (role) => {
    as(role);
    expect(await unsubscribeFeedAction(FEED_A)).toEqual({ ok: true, message: 'Subscription removed.' });
    expect(db.table('library_feeds').map((f) => f.id)).toEqual([FEED_A_BY_CHILD, FEED_B]);
  });

  it.each(NON_MANAGERS)('ACTION-E69528A3174C a %s is refused and the subscription stays', async (role) => {
    as(role);
    const before = state();
    expect(await unsubscribeFeedAction(FEED_A)).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
  });

  it("ACTION-E69528A3174C a parent naming family B's feed is refused, and neither family changes", async () => {
    const before = state();
    expect(await unsubscribeFeedAction(FEED_B)).toEqual({ ok: false, error: 'Could not remove that subscription.' });
    expect(state()).toEqual(before);
  });
});

describe('addBookAction', () => {
  it.each(MEMBERS_NOT_GUEST)('ACTION-BFAA74E0C4FE a %s keeps a title and a page link in their own family', async (role) => {
    as(role);
    const result = await addBookAction(form({ title: 'Matilda', author: 'Roald Dahl', pageUrl: 'https://books.example.com/matilda', mediaUrl: '' }));
    expect(result).toEqual({ ok: true, message: 'Added to your library.' });
    expect(db.table('library_items').filter((i) => i.title === 'Matilda')).toEqual([expect.objectContaining({
      family_id: A, kind: 'book', feed_id: null, media_url: null,
      page_url: 'https://books.example.com/matilda', created_by: `user-${role}`,
    })]);
  });

  it.each(MANAGERS)('ACTION-BFAA74E0C4FE a %s attaches an audio address to a book', async (role) => {
    as(role);
    const result = await addBookAction(form({ title: 'Audio Book', mediaUrl: 'https://books.example.com/a.mp3' }));
    expect(result).toEqual({ ok: true, message: 'Added to your library.' });
    expect(db.table('library_items').filter((i) => i.title === 'Audio Book'))
      .toEqual([expect.objectContaining({ family_id: A, media_url: 'https://books.example.com/a.mp3' })]);
  });

  it.each(NON_MANAGERS)('ACTION-BFAA74E0C4FE a %s is refused an audio address and nothing is written', async (role) => {
    as(role);
    const before = state();
    expect(await addBookAction(form({ title: 'Audio Book', mediaUrl: 'https://books.example.com/a.mp3' }))).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
  });
});

describe('saveProgressAction', () => {
  it.each(ROLES)("ACTION-86DDF0156A9D a %s saves their own place on their family's book, keyed to themselves", async (role) => {
    as(role);
    expect(await saveProgressAction({ itemId: ITEM_A, positionSeconds: 120, saved: true })).toEqual({ ok: true, message: 'Saved.' });
    expect(db.table('library_progress')).toEqual([expect.objectContaining({
      family_id: A, item_id: ITEM_A, user_id: `user-${role}`, position_seconds: 120, saved: true,
    })]);
  });

  it.each(['parent', 'child'])("ACTION-86DDF0156A9D a %s naming family B's book is refused and no bookmark is written", async (role) => {
    as(role);
    const before = state();
    expect(await saveProgressAction({ itemId: ITEM_B, positionSeconds: 30 })).toEqual({ ok: false, error: 'Could not save your place.' });
    expect(state()).toEqual(before);
  });
});
