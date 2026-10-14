// N5 — the Photos module read all of family_photos in ONE unpaged query.
//
// PostgREST answers that with at most 1,000 rows (db-max-rows) and no error.
// Every number on the page was then worked out from those rows: an album whose
// photos are older than the newest 1,000 uploads read "0 photos" with a
// placeholder cover (a family may think the photos are lost and upload them
// again), the favourites badge and "All Photos" stopped at the newest 1,000,
// and the caption/tag search answered "No photos yet" for an older photo.
//
// Driven through the REAL module against an in-memory database capped at
// 1,000 rows per response, with each read showing exactly what the module's
// own query returned (fetchedQueryModule in tests/helpers/module-harness.tsx).
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, has, nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);
// Signing and the lightbox's focus trap are browser concerns these cases do not reach.
vi.mock('@/lib/storage/use-family-media', () => ({ useFamilyMediaUrls: () => (ref: string | null | undefined) => ref ?? null }));
vi.mock('@/lib/a11y/use-dialog-behavior', () => ({ useDialogBehavior: () => {} }));

const { PhotosModule } = await import('@/components/modules/photos-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const pad = (n: number) => String(n).padStart(4, '0');
let db: InMemorySupabase;
/** Every ranged family_photos read, as the [from, to] it asked the server for. */
let ranges: [number, number][];

const photo = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, album_id: null, uploaded_by: 'user-1', storage_path: `${FAMILY}/photos/${id}.jpg`,
  url: `https://media.invalid/${id}.jpg`, thumbnail_url: null, caption: null, taken_at: null, tags: [], member_tags: [],
  is_favorite: false, media_type: 'image', size_bytes: 1024, created_at: createdAt, ...extra,
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  ranges = [];
  // The same database, watched: each ranged photo read is noted as it is sent.
  h.db = withFaults(db, (table, calls) => {
    const range = calls.find((c) => c.method === 'range');
    if (table === 'family_photos' && range) ranges.push(range.args as [number, number]);
    return null;
  });
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  // The summer album: 100 photos from 2024, older than everything since.
  db.seed('family_albums', [{ id: 'album-summer', family_id: FAMILY, name: 'Summer 2024', description: null, cover_url: null, kind: 'vacation', is_shared: true, photo_count: 100, created_by: 'user-1', created_at: '2024-06-01T00:00:00Z' }]);
  db.seed('family_photos', Array.from({ length: 100 }, (_, i) => photo(`old-${pad(i)}`, `2024-07-01T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}:00Z`, {
    album_id: 'album-summer',
    is_favorite: i < 3,
    ...(i === 7 ? { caption: 'Sunset at Lake Tahoe' } : {}),
    ...(i === 8 ? { tags: ['grandpa'] } : {}),
  })));
  // A thousand newer uploads, none in an album.
  db.seed('family_photos', Array.from({ length: 1000 }, (_, i) => photo(`new-${pad(i)}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function screen(): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(PhotosModule));
  for (let i = 0; i < 6; i++) { await settle(); tree = render(h.hooks, createElement(PhotosModule)); }
  return tree;
}
const tab = (tree: ReactNode, key: string) => nodes(tree).find((n) => n.type === 'button' && String(n.props.className).includes('tab-item') && text(n).startsWith(t(key))) as Node;
const gridPhotos = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'img' && String(n.props.src).startsWith('https://media.invalid/')).length;

describe('the photo library counts past a thousand', () => {
  it('an album of older photos shows its count and its newest photo as the cover', async () => {
    const tree = await screen();
    const card = nodes(tree).find((n) => n.type === 'button' && has(n.props.children as ReactNode, 'Summer 2024')) as Node;
    expect(card).toBeDefined();
    expect(text(card)).toContain(t('photosModule.photosCount', { count: 100 }));
    expect(nodes(card.props.children as ReactNode).find((n) => n.type === 'img')?.props.src).toBe('https://media.invalid/old-0099.jpg');
  });

  it('the favourites badge counts every favourite, not those among the newest 1,000', async () => {
    expect(text(tab(await screen(), 'photosModule.favorites'))).toBe(`${t('photosModule.favorites')}3`);
  });

  it('All Photos pages, says how many there are, and loads more on request', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    let tree = await screen();
    expect(gridPhotos(tree)).toBe(120);
    expect(has(tree, t('photosModule.showingNOfTotal', { shown: 120, total: 1100 }))).toBe(true);

    await click(byName(tree, t('photosModule.loadMore'), 'button'));
    tree = await screen();
    expect(gridPhotos(tree)).toBe(240);
    expect(has(tree, t('photosModule.showingNOfTotal', { shown: 240, total: 1100 }))).toBe(true);
  });

  it.each([['a caption', 'Lake Tahoe', 'old-0007'], ['a tag', 'grandpa', 'old-0008']])('search finds an older photo by %s', async (_by, term, id) => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    change(nodes(await screen()).find((n) => n.type === 'input' && n.props.placeholder === t('photos.searchPhotos')) as Node, term);
    const tree = await screen();

    expect(nodes(tree).filter((n) => n.type === 'img').map((n) => n.props.src)).toEqual([`https://media.invalid/${id}.jpg`]);
    expect(has(tree, t('photos.noPhotosYet'))).toBe(false);
  });
});

// Round 1 of review. "Load more" re-read the whole prefix in ONE request,
// `.range(0, shown - 1)`, so from the ninth press on the server's cap handed
// back the same 1,000 rows: the grid stopped at 1,000, the page said "Showing
// 1000 of 1100", and the button did nothing. And because the page count and the
// search were both part of the read's key, every press and every keystroke
// began a new read whose first render is a loading one — the whole page,
// search box included, was swapped for a skeleton.
const searchBox = (tree: ReactNode) => nodes(tree).find((n) => n.type === 'input' && n.props.placeholder === t('photos.searchPhotos'));
const loadMore = (tree: ReactNode) => nodes(tree).find((n) => n.type === 'button' && text(n).includes(t('photosModule.loadMore')));
const gridIds = (tree: ReactNode) => nodes(tree)
  .filter((n) => n.type === 'img' && String(n.props.src).startsWith('https://media.invalid/'))
  .map((n) => String(n.props.src).slice('https://media.invalid/'.length, -'.jpg'.length));
/** Press "Load more" until it is gone, as a person scrolling the library would. */
async function loadEverything(start: ReactNode): Promise<{ tree: ReactNode; presses: number[] }> {
  let tree = start;
  const presses: number[] = [];
  for (let press = 0; press < 20; press++) {
    const more = loadMore(tree);
    if (!more) break;
    const before = ranges.length;
    await click(more);
    tree = await screen();
    presses.push(ranges.length - before);
  }
  return { tree, presses };
}

describe('All Photos reaches the end of the library, and the page stays while it loads', () => {
  it('Load more reaches all 1,100 photos past the server’s 1,000-row cap, one page per press', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    const { tree, presses } = await loadEverything(await screen());

    const ids = gridIds(tree);
    expect(ids).toHaveLength(1100);
    expect(new Set(ids).size).toBe(1100);
    expect(ids.at(-1)).toBe('old-0000');
    expect(loadMore(tree)).toBeUndefined();
    // Each press is ONE read of the next page — not the prefix again.
    expect(presses.length).toBeGreaterThanOrEqual(9);
    expect(presses).toEqual(Array(presses.length).fill(1));
    // And no request asks for more than a page (with its row of overlap).
    expect(Math.max(...ranges.map(([from, to]) => to - from + 1))).toBeLessThanOrEqual(121);
  });

  it('without a count, Load more still reaches the end, and then goes', async () => {
    // The head counts fail; the grid's own pages (ranged) and the album covers (limited) do not.
    h.fault = (table, calls) => (table === 'family_photos' && !calls.includes('range') && !calls.includes('limit') ? { message: 'count refused' } : null);
    await click(tab(await screen(), 'photosModule.allPhotos'));
    const { tree, presses } = await loadEverything(await screen());

    expect(gridIds(tree)).toHaveLength(1100);
    expect(loadMore(tree), 'a button that can only append nothing is gone').toBeUndefined();
    expect(presses.length).toBeLessThanOrEqual(10);
  });

  it('a keystroke keeps the search box, and the grid it was showing, while the search loads', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    change(searchBox(await screen()) as Node, 'L');

    // The very next render: the read for "L" has started, not finished.
    const typing = render(h.hooks, createElement(PhotosModule));
    expect(searchBox(typing), 'the search box is still on the page').toBeDefined();
    expect(searchBox(typing)?.props.value).toBe('L');
    expect(gridPhotos(typing)).toBe(120);
    expect(has(typing, t('photos.noPhotosYet'))).toBe(false);

    change(searchBox(typing) as Node, 'Lake Tahoe');
    const found = await screen();
    expect(searchBox(found)).toBeDefined();
    expect(gridIds(found)).toEqual(['old-0007']);
  });

  it('Load more keeps the page and the grid while the next page loads', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    (loadMore(await screen())?.props.onClick as () => void)();

    const waiting = render(h.hooks, createElement(PhotosModule));
    expect(searchBox(waiting), 'the header is still on the page').toBeDefined();
    expect(gridPhotos(waiting)).toBe(120);

    const done = await screen();
    expect(gridPhotos(done)).toBe(240);
    expect(has(done, t('photosModule.showingNOfTotal', { shown: 240, total: 1100 }))).toBe(true);
  });

  it('a photo added after the grid was read is neither skipped nor shown twice', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    const first = gridIds(await screen());
    expect(first).toHaveLength(120);
    // Someone else uploads: every offset below it moves by one.
    db.seed('family_photos', [photo('newest', '2026-10-13T12:00:00Z')]);

    const { tree } = await loadEverything(await screen());
    const ids = gridIds(tree);
    expect(ids[0]).toBe('newest');
    expect(ids).toHaveLength(1101);
    expect(new Set(ids).size).toBe(1101);
    for (const id of first) expect(ids).toContain(id);
  });

  it('a favourite marked deep in the grid re-reads every page loaded, not the first one', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    let tree = await screen();
    for (let press = 0; press < 2; press++) { await click(loadMore(tree) as Node); tree = await screen(); }
    expect(gridPhotos(tree)).toBe(360);

    const target = gridIds(tree)[300];
    await click(nodes(tree).filter((n) => n.type === 'button' && n.props['aria-label'] === t('photosModule.addFavorite'))[300]);
    tree = await screen();

    expect(db.table('family_photos').find((row) => row.id === target)?.is_favorite).toBe(true);
    expect(gridPhotos(tree)).toBe(360);
    expect(gridIds(tree)[300]).toBe(target);
    expect(nodes(tree).filter((n) => n.type === 'button' && n.props['aria-label'] === t('photosModule.removeFavorite'))).toHaveLength(1);
  });
});

// Round 2 of review.
//
// R2-faded-photo-grid-ratchet — while a search loaded, the grid it replaced was
// drawn at 60% (`pointer-events-none opacity-60`), which put its captions below
// 4.5:1 (tests/informative-text-is-not-faded.test.ts went red) and stopped only
// the mouse: each tile's open button could still be reached with Tab and
// pressed with Enter, opening the viewer at an index the new results then
// gave to another photo.
//
// R2-load-more-concurrent-reread — the hook re-reads on its own (a realtime
// event, coming back online), and "Load more" could not see those reads: its
// append superseded one in flight, so another member's caption edit never
// reached the grid; and when one landed first and shifted the list, the append
// gave up silently while the extent still grew, so with the count unreadable
// the button went away with photos left to show.
//
// N5-tag-search-case — the tag match became an exact, case-sensitive element
// match, so "Grandpa" no longer found a photo tagged "grandpa".

/** Page reads of family_photos whose answers are held back, like a slow network: the database answers when asked, the reply arrives on release. */
const gate = { hold: 0, held: [] as (() => void)[] };
function slowPages<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== 'from') return Reflect.get(object, property, receiver);
      return (table: string) => {
        const builder = (object as unknown as { from: (name: string) => object }).from(table);
        const calls: string[] = [];
        const proxy: object = new Proxy(builder, {
          get(inner, key) {
            if (key === 'then') {
              return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
                const answer = (inner as PromiseLike<unknown>).then((value) => value);
                if (table !== 'family_photos' || !calls.includes('range') || gate.hold === 0) return answer.then(resolve, reject);
                gate.hold -= 1;
                return new Promise<void>((go) => gate.held.push(go)).then(() => answer).then(resolve, reject);
              };
            }
            const value = Reflect.get(inner, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              calls.push(String(key));
              const result = Reflect.apply(value, inner, args);
              return result === inner ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}
const release = async () => { for (const go of gate.held.splice(0)) go(); await settle(); };
/** A tile's own way into the viewer: the nested button over its media, in the grid and in the list. */
const openers = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button' && String(n.props.className ?? '').includes('focus-ring'));
const favourites = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button' && n.props['aria-label'] === t('photosModule.addFavorite'));

describe('round 2: the grid while it reloads, and Load more beside the hook’s own re-reads', () => {
  beforeEach(() => { gate.hold = 0; gate.held = []; h.db = slowPages(h.db as object); });

  it.each(['grid', 'list'])('while a search loads, the %s it replaces is at full strength, out of reach, and says it is searching', async (shape) => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    if (shape === 'list') await click(byName(await screen(), t('photosModule.showList'), 'button'));
    change(searchBox(await screen()) as Node, 'L');

    // The very next render: the read for "L" has started, not finished.
    const typing = render(h.hooks, createElement(PhotosModule));
    expect(gridPhotos(typing)).toBe(120);
    const inert = nodes(typing).filter((n) => n.props.inert === true);
    expect(inert, 'one inert container holds the old results').toHaveLength(1);
    // Every control on the old results is inside it: each way into the viewer, each favourite.
    expect(openers(typing)).toHaveLength(120);
    expect(openers(inert[0])).toHaveLength(120);
    expect(favourites(inert[0])).toHaveLength(favourites(typing).length);
    // Drawn at full strength: nothing between the page and a caption fades it.
    expect(String(inert[0].props.className)).not.toMatch(/opacity-|pointer-events-none/);
    // Busy, in words a person reads and a screen reader is told.
    expect(text(nodes(typing).find((n) => n.props.role === 'status'))).toContain(t('photosModule.searching'));
    expect(nodes(typing).some((n) => n.props['aria-busy'] === true)).toBe(true);

    // The results land: the grid is live again and nothing says it is searching.
    const found = await screen();
    expect(gridPhotos(found)).toBeGreaterThan(0);
    expect(nodes(found).some((n) => n.props.inert === true)).toBe(false);
    expect(text(nodes(found).find((n) => n.props.role === 'status'))).toBe('');
  });

  it('a caption another member edits while Load more runs still reaches the grid', async () => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    const tree = await screen();
    const target = gridIds(tree)[5];
    // Dad edits a caption; the realtime event starts the hook's own re-read, still on its way…
    (db.table('family_photos').find((row) => row.id === target) as Record<string, unknown>).caption = 'Edited by Dad';
    gate.hold = 1;
    const realtime = h.realtime.family_photos();
    await settle();
    expect(gate.held).toHaveLength(1);

    // …when Ada presses Load more.
    await click(loadMore(tree) as Node);
    await release();
    await realtime;

    const after = await screen();
    expect(gridPhotos(after)).toBe(240);
    expect(has(after, 'Edited by Dad'), 'the edit is on the grid').toBe(true);
    expect(new Set(gridIds(after)).size).toBe(240);
  });

  it('without a count, a re-read that shifts the grid before the next page lands reads it again a page longer, and Load more stays', async () => {
    h.fault = (table, calls) => (table === 'family_photos' && !calls.includes('range') && !calls.includes('limit') ? { message: 'count refused' } : null);
    await click(tab(await screen(), 'photosModule.allPhotos'));
    const tree = await screen();
    expect(gridPhotos(tree)).toBe(120);

    // Load more is pressed and its page read; the answer is on its way…
    gate.hold = 1;
    await click(loadMore(tree) as Node);
    expect(gate.held).toHaveLength(1);
    // …while someone uploads, and the realtime re-read lands first: every row moves down one.
    db.seed('family_photos', [photo('newest', '2026-10-13T12:00:00Z')]);
    await h.realtime.family_photos();
    await release();

    const after = await screen();
    const ids = gridIds(after);
    expect(ids[0]).toBe('newest');
    expect(ids).toHaveLength(240);
    expect(new Set(ids).size).toBe(240);
    expect(loadMore(after), 'photos remain, so the button does').toBeDefined();

    // And it still reaches the end.
    const { tree: end } = await loadEverything(after);
    expect(gridIds(end)).toHaveLength(1101);
    expect(loadMore(end)).toBeUndefined();
  });
});

describe('round 2: a tag search does not depend on the case it is typed in', () => {
  it.each(['Grandpa', 'GRANDPA'])('a tag search matches the stored lower-case tag when typed as %s', async (term) => {
    await click(tab(await screen(), 'photosModule.allPhotos'));
    change(searchBox(await screen()) as Node, term);
    const tree = await screen();

    expect(gridIds(tree)).toEqual(['old-0008']);
  });
});
