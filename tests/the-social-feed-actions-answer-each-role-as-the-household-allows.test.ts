// The seven Social Feed actions, called the way the reader page calls them, by
// every household role but a guest, with valid input and with another family's
// ids.
//
// THE POLICY, from the sources rather than from the action:
//   - `social_reader_sources` and `social_reader_items` carry one policy each,
//     "Members manage …" FOR ALL `is_family_member(family_id)`
//     (supabase/migrations/0101_social_feed.sql:68-79). Nothing later narrows
//     them: 0356 leaves social_reader_* alone on purpose (0356:39-40), and
//     neither 0464 nor 0481 attaches the guest guard to them.
//   - The page offers every control to every member: the module gates no button
//     on a role (components/modules/social-feed-module.tsx:128,159,219,230,244,
//     258), the feature is free (lib/constants/feature-catalog.ts:70) and the
//     navigation entry is not `manage` (lib/constants/navigation.ts:129).
//   So parent, adult, teen, child (and a kid login) and caregiver each write,
//   and that is pinned. A GUEST is not pinned either way: the database and the
//   screen let a guest write, while the product's model of a guest is a viewer
//   (0464's header, lib/constants/roles.ts ROLE_DESCRIPTIONS.guest), so that is
//   an owner decision, recorded in the PR body.
//   - The family is the session's: every write and every id lookup is filtered
//     to `ctx.active.familyId`, so another family's row is "could not" and
//     stays as it was.
//
// Mocked: the session, the server client factory, next/cache, the translator
// (the real en-US source catalogue through `translate`) and the one network
// seam, `fetchPublicText`, which answers a fixed OpenGraph page.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, userIdOf, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
  fetched: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/public-calendar-fetch', () => ({
  fetchPublicText: async (url: string) => {
    harness.fetched.push(url);
    return {
      ok: true,
      url,
      contentType: 'text/html; charset=utf-8',
      text: '<html><head>'
        + '<meta property="og:site_name" content="Example News">'
        + '<meta property="og:title" content="School fair this Saturday">'
        + '<meta property="og:description" content="Stalls open at ten.">'
        + '</head><body></body></html>',
    };
  },
}));

const {
  addByUrlAction, addFeedItemAction, addSourceAction, markAllReadAction, markReadAction, removeSourceAction, toggleFavoriteAction,
} = await import('@/app/(app)/dashboard/social-feed/actions');

const SRC_A = 'a0000000-0000-4000-8000-0000000c0001';
const SRC_B = 'b0000000-0000-4000-8000-0000000c0001';
const ITEM_A1 = 'a0000000-0000-4000-8000-0000000d0001';
const ITEM_A2 = 'a0000000-0000-4000-8000-0000000d0002';
const ITEM_B = 'b0000000-0000-4000-8000-0000000d0001';
const LINK = 'https://news.example.com/fair';
const COULD_NOT_REMOVE = 'Could not remove that source. Refresh and try again.';
const COULD_NOT_UPDATE = 'Could not update that item.';

/**
 * Every caller the live schema and the page both let write the feed. A guest
 * is left out on purpose: see the header.
 */
const WRITERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
const sources = () => db.table('social_reader_sources');
const items = () => db.table('social_reader_items');
const row = (rows: Row[], id: string) => rows.find((r) => r.id === id);
/** Family B's rows in both tables, deep-copied, to prove a call left them exactly as they were. */
const familyB = () => structuredClone([
  ...sources().filter((r) => r.family_id === FAMILY_B),
  ...items().filter((r) => r.family_id === FAMILY_B),
]);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    // uq_social_reader_items_external (0101:61): one row per platform item per family.
    uniques: { social_reader_items: [['family_id', 'platform', 'external_id']] },
    defaults: { social_reader_items: { is_read: false, is_favorite: false, media_urls: [] } },
  });
  harness.db = db;
  harness.caller = 'parent';
  harness.revalidatePath = [];
  harness.fetched = [];
  db.seed('social_reader_sources', [
    { id: SRC_A, family_id: FAMILY_A, platform: 'youtube', display_name: 'YouTube', category: 'family', is_active: true },
    { id: SRC_B, family_id: FAMILY_B, platform: 'youtube', display_name: 'Theirs', category: 'family', is_active: true },
  ]);
  db.seed('social_reader_items', [
    { id: ITEM_A1, family_id: FAMILY_A, source_id: SRC_A, platform: 'youtube', author_name: 'Grandpa', is_read: false, is_favorite: false },
    { id: ITEM_A2, family_id: FAMILY_A, source_id: SRC_A, platform: 'youtube', author_name: 'Aunt', is_read: false, is_favorite: false },
    // Family B has already saved the very link family A will add.
    { id: ITEM_B, family_id: FAMILY_B, source_id: SRC_B, platform: 'web', author_name: 'Example News', external_id: LINK, is_read: false, is_favorite: false },
  ]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('addSourceAction (ACTION-E1802CD42535)', () => {
  it.each(WRITERS)('ACTION-E1802CD42535 a %s connects a source in their own family, attributed to them', async (caller) => {
    as(caller);
    const before = familyB();
    expect(await addSourceAction({ platform: 'instagram', displayName: 'Cousins', handle: '@cousins', category: 'friends' })).toEqual({ ok: true });

    expect(sources().filter((r) => r.display_name === 'Cousins')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, platform: 'instagram', handle: '@cousins', category: 'friends', account_count: 1, created_by: userIdOf(caller),
    })]);
    expect(familyB()).toEqual(before);
    expect(harness.revalidatePath).toEqual(['/dashboard/social-feed']);
  });

  it('ACTION-E1802CD42535 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    await expect(addSourceAction({ platform: 'instagram' })).rejects.toThrow('NEXT_REDIRECT');
    expect(sources()).toHaveLength(2);
  });
});

describe('removeSourceAction (ACTION-955CFD2274EE)', () => {
  it.each(WRITERS)('ACTION-955CFD2274EE a %s disconnects a source of their own family', async (caller) => {
    as(caller);
    expect(await removeSourceAction({ id: SRC_A })).toEqual({ ok: true });
    expect(row(sources(), SRC_A)).toBeUndefined();
    expect(row(sources(), SRC_B)).toBeDefined();
  });

  it("ACTION-955CFD2274EE another family's source is not removed, and the caller is told", async () => {
    const before = structuredClone(sources());
    expect(await removeSourceAction({ id: SRC_B })).toEqual({ ok: false, error: COULD_NOT_REMOVE });
    expect(sources()).toEqual(before);
    expect(harness.revalidatePath).toEqual([]);
  });

  it('ACTION-955CFD2274EE a signed-out caller is sent to sign in and nothing is removed', async () => {
    as(null);
    await expect(removeSourceAction({ id: SRC_A })).rejects.toThrow('NEXT_REDIRECT');
    expect(sources()).toHaveLength(2);
  });
});

describe('toggleFavoriteAction (ACTION-C276C13E409F)', () => {
  it.each(WRITERS)('ACTION-C276C13E409F a %s bookmarks an item of their own family', async (caller) => {
    as(caller);
    expect(await toggleFavoriteAction({ id: ITEM_A1, favorite: true })).toEqual({ ok: true });
    expect(row(items(), ITEM_A1)?.is_favorite).toBe(true);
    expect(row(items(), ITEM_A2)?.is_favorite).toBe(false);
  });

  it("ACTION-C276C13E409F another family's item is not bookmarked, and the caller is told", async () => {
    const before = structuredClone(items());
    expect(await toggleFavoriteAction({ id: ITEM_B, favorite: true })).toEqual({ ok: false, error: COULD_NOT_UPDATE });
    expect(items()).toEqual(before);
  });
});

describe('markReadAction (ACTION-B326FDF1A333)', () => {
  it.each(WRITERS)('ACTION-B326FDF1A333 a %s marks an item of their own family read', async (caller) => {
    as(caller);
    expect(await markReadAction({ id: ITEM_A1, read: true })).toEqual({ ok: true });
    expect(row(items(), ITEM_A1)?.is_read).toBe(true);
    expect(row(items(), ITEM_A2)?.is_read).toBe(false);
  });

  it("ACTION-B326FDF1A333 another family's item is not marked, and the caller is told", async () => {
    const before = structuredClone(items());
    expect(await markReadAction({ id: ITEM_B, read: true })).toEqual({ ok: false, error: COULD_NOT_UPDATE });
    expect(items()).toEqual(before);
  });
});

describe('markAllReadAction (ACTION-1BF1CFD2A289)', () => {
  it.each(WRITERS)("ACTION-1BF1CFD2A289 a %s marks every item of their own family read, and no other family's", async (caller) => {
    as(caller);
    const before = familyB();
    expect(await markAllReadAction()).toEqual({ ok: true });

    expect(items().filter((r) => r.family_id === FAMILY_A).map((r) => r.is_read)).toEqual([true, true]);
    expect(familyB()).toEqual(before);
    expect(row(items(), ITEM_B)?.is_read).toBe(false);
  });

  it('ACTION-1BF1CFD2A289 a signed-out caller is sent to sign in and nothing is marked', async () => {
    as(null);
    await expect(markAllReadAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(items().map((r) => r.is_read)).toEqual([false, false, false]);
  });
});

describe('addFeedItemAction (ACTION-70192299722B)', () => {
  it.each(WRITERS)('ACTION-70192299722B a %s adds an item to their own family, attributed to them', async (caller) => {
    as(caller);
    const before = familyB();
    expect(await addFeedItemAction({
      sourceId: SRC_A, platform: 'youtube', authorName: 'Grandma', content: 'Garden tour',
      permalink: 'https://video.example.com/garden', kind: 'video',
    })).toEqual({ ok: true });

    expect(items().filter((r) => r.author_name === 'Grandma')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, source_id: SRC_A, platform: 'youtube', content: 'Garden tour',
      permalink: 'https://video.example.com/garden', kind: 'video', created_by: userIdOf(caller),
    })]);
    expect(familyB()).toEqual(before);
  });

  it('ACTION-70192299722B a signed-out caller is sent to sign in and nothing is added', async () => {
    as(null);
    await expect(addFeedItemAction({ platform: 'youtube', authorName: 'Grandma' })).rejects.toThrow('NEXT_REDIRECT');
    expect(items()).toHaveLength(3);
  });
});

describe('addByUrlAction (ACTION-4391301E1AC2)', () => {
  it.each(WRITERS)('ACTION-4391301E1AC2 a %s saves a pasted link into their own family, even one another family already saved', async (caller) => {
    as(caller);
    const before = familyB();
    expect(await addByUrlAction({ url: LINK, category: 'family' })).toEqual({ ok: true });

    expect(harness.fetched).toEqual([LINK]);
    expect(items().filter((r) => r.family_id === FAMILY_A && r.external_id === LINK)).toEqual([expect.objectContaining({
      platform: 'web', author_name: 'Example News', permalink: LINK, category: 'family', created_by: userIdOf(caller),
      content: 'School fair this Saturday\n\nStalls open at ten.',
    })]);
    expect(familyB()).toEqual(before);
  });

  it('ACTION-4391301E1AC2 the same link pasted twice in one family is stored once', async () => {
    expect(await addByUrlAction({ url: LINK })).toEqual({ ok: true });
    expect(await addByUrlAction({ url: LINK })).toEqual({ ok: true });
    expect(items().filter((r) => r.family_id === FAMILY_A && r.external_id === LINK)).toHaveLength(1);
  });

  it('ACTION-4391301E1AC2 a signed-out caller is sent to sign in before anything is fetched or written', async () => {
    as(null);
    await expect(addByUrlAction({ url: LINK })).rejects.toThrow('NEXT_REDIRECT');
    expect(harness.fetched).toEqual([]);
    expect(items()).toHaveLength(3);
  });
});
