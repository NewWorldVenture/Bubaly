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
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
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

const photo = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, album_id: null, uploaded_by: 'user-1', storage_path: `${FAMILY}/photos/${id}.jpg`,
  url: `https://media.invalid/${id}.jpg`, thumbnail_url: null, caption: null, taken_at: null, tags: [], member_tags: [],
  is_favorite: false, media_type: 'image', size_bytes: 1024, created_at: createdAt, ...extra,
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
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
