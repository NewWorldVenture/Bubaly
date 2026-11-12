// CONTROL sweep, components/memories/on-this-day-card.tsx: the one control is
// the card itself, a link to Memories. Driven through the real OnThisDayCard on
// hook slots, reading family_photos with its OWN fetcher against the in-memory
// database, so the filters it names (this family, dated, has a url) decide
// what is on screen.
//
// Roles: the card has no role check and writes nothing. Home renders it for
// every role (app/(app)/home/page.tsx:744) and /dashboard/memories is not on
// the guest-withheld list (lib/auth/guest-scope.ts:18), so what a member sees
// is what the family_photos read returns to them.
import { existsSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/media/family-media-img', async () => ({ FamilyMediaImg: (await import('./helpers/module-harness')).ui.FamilyMediaImg }));

const { OnThisDayCard } = await import('@/components/memories/on-this-day-card');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const OTHER_FAMILY = '0f0f0f0f-0000-4000-8000-000000000002';
// Noon UTC: the same calendar day in Los Angeles (04:00) and Tokyo (21:00).
const TODAY = new Date('2026-11-12T12:00:00Z');
let db: InMemorySupabase;

const photo = (id: string, taken_at: string | null, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, taken_at, url: `families/${FAMILY}/${id}.jpg`, thumbnail_url: null, caption: null, ...extra,
});

/** Mount, let the card's own read answer, and render what it then shows. */
async function screen(): Promise<ReactNode> {
  render(h.hooks, createElement(OnThisDayCard));
  await settle();
  return render(h.hooks, createElement(OnThisDayCard));
}
const links = (tree: ReactNode): Node[] => nodes(tree).filter((n) => n.type === 'a');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  Object.assign(h.app, { familyId: FAMILY });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the "On this day" card on Home', () => {
  it('CONTROL-1CD8C8662EAB: on a day with a memory the card is one link, named in English, to the Memories page', async () => {
    db.seed('family_photos', [photo('photo-beach', '2024-11-12T12:00:00Z', { caption: 'Beach day' })]);
    const tree = await screen();

    const [card, ...rest] = links(tree);
    expect(rest).toEqual([]);
    // Its name is its words: the translated heading, how long ago, the caption.
    expect(text(card)).toBe('On this day· 2 years agoBeach day');
    expect(nodes(card).filter((n) => n.type === 'img').map((n) => n.props.alt)).toEqual(['Beach day']);
    expect(card.props.href).toBe('/dashboard/memories');
    expect(existsSync('app/(app)/dashboard/memories/page.tsx')).toBe(true);
  });

  it('CONTROL-1CD8C8662EAB: several memories are counted on the card and an uncaptioned photo still has alt text', async () => {
    db.seed('family_photos', [
      photo('photo-one', '2025-11-12T12:00:00Z'),
      photo('photo-five', '2021-11-12T12:00:00Z', { caption: 'First bike' }),
    ]);
    const [card] = links(await screen());
    expect(text(card)).toBe('On this day· 2 memories · from 5 years ago');
    expect(nodes(card).filter((n) => n.type === 'img').map((n) => n.props.alt)).toEqual(['Family memory', 'First bike']);
  });

  it('CONTROL-1CD8C8662EAB: no card on an ordinary day, for another family\'s photo, or for a photo without a date or a file', async () => {
    db.seed('family_photos', [
      photo('photo-other-day', '2024-06-01T12:00:00Z', { caption: 'Summer' }),
      photo('photo-this-year', '2026-11-12T09:00:00Z', { caption: 'This morning' }),
      photo('photo-neighbours', '2024-11-12T12:00:00Z', { family_id: OTHER_FAMILY, caption: 'Not ours' }),
      photo('photo-undated', null, { caption: 'Undated' }),
      photo('photo-no-file', '2024-11-12T12:00:00Z', { url: null, caption: 'No file' }),
    ]);
    const tree = await screen();
    expect(tree).toBeNull();
    // The read did happen, and for this family: the empty screen is the answer, not a skipped query.
    expect(h.calls.map((c) => c.table)).toEqual(['family_photos']);
  });

  it('CONTROL-1CD8C8662EAB: a failed read hides the card and says so in the console', async () => {
    db.seed('family_photos', [photo('photo-beach', '2024-11-12T12:00:00Z', { caption: 'Beach day' })]);
    h.fault = () => ({ message: 'permission denied for table family_photos' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tree = await screen();
    expect(tree).toBeNull();
    expect(logged).toHaveBeenCalledWith('[on-this-day] memories read failed — card hidden', 'permission denied for table family_photos');
  });
});
