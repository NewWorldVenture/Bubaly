// Trip Intel stores only recommendations the card can render, and renders what
// is stored defensively (U7).
//
// `saveTripPlanAction` inserted `input.recommendations` as it came from the
// client — any active member, any shape, any size — into a jsonb column with
// no check, and the page cast each stored row to the typed shape for a card
// whose expand dereferences `recs.restaurants.length`: one forged save (or the
// column's own `{}` default) took the whole family's Trip Intel page down on
// expand. The action now holds the value to the parser's shape and caps and to
// 64 KiB; the page normalises each stored row; the card treats a missing list
// as empty.
//
// Driven through the real action and the real page against an in-memory
// database.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const io = vi.hoisted(() => ({ db: null as unknown, moduleProps: null as unknown }));
const ctx = { user: { id: 'user-1' }, active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'America/Los_Angeles' } } };
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx, requireFeature: async () => ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => io.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
// The page's props are the question here; the module's own render is the
// harness test beside this one.
vi.mock('@/components/modules/trip-intel-module', () => ({ TripIntelModule: (props: unknown) => { io.moduleProps = props; return null; } }));

const { saveTripPlanAction } = await import('@/app/(app)/dashboard/trip-intel/actions');
const TripIntelPage = (await import('@/app/(app)/dashboard/trip-intel/page')).default;
const { emptyTripRecommendations, normalizeTripRecommendations, parseTripResearch } = await import('@/lib/trips/research');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;
const wellFormed = {
  overview: 'A warm week in Lisbon.',
  restaurants: [{ name: 'Time Out Market', cuisine: 'Portuguese', why: 'Something for everyone.', priceLevel: '$$' }],
  activities: [{ name: 'Tram 28', category: 'culture', why: 'The hills without the climb.' }],
  tips: ['Book the Oceanário ahead.'],
};
const save = (recommendations: unknown) => saveTripPlanAction({ title: 'Lisbon', destination: 'Lisbon', recommendations: recommendations as never });

beforeEach(() => {
  db = createInMemorySupabase();
  io.db = db; io.moduleProps = null;
  db.seed('family_members', [{ id: 'member-1', family_id: 'fam-1', display_name: 'Ada', color: null, is_active: true }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('saving a trip plan', () => {
  it('refuses recommendations without the lists the card renders, and stores nothing', async () => {
    expect(await save({ overview: 'Looks nice' })).toEqual({ ok: false, error: t('actions.tripRecommendationsInvalid') });
    expect(await save('not an object')).toEqual({ ok: false, error: t('actions.tripRecommendationsInvalid') });
    expect(await save(null)).toEqual({ ok: false, error: t('actions.tripRecommendationsInvalid') });
    expect(db.table('trip_plans')).toEqual([]);
  });

  it('refuses a set that would store more than 64 KiB', async () => {
    const huge = { ...wellFormed, tips: ['x'.repeat(70 * 1024)] };
    expect(await save(huge)).toEqual({ ok: false, error: t('actions.tripRecommendationsInvalid') });
    expect(db.table('trip_plans')).toEqual([]);
  });

  it('stores a well-formed set, normalised: lists capped, fields strings, stray keys dropped', async () => {
    const padded = {
      ...wellFormed, surprise: { nested: true },
      restaurants: Array.from({ length: 12 }, (_, i) => ({ name: `Place ${i}`, cuisine: 'Local', why: 'Good', extra: i })),
      tips: Array.from({ length: 9 }, (_, i) => `Tip ${i}`),
    };
    const res = await save(padded);
    expect(res).toMatchObject({ ok: true });
    const [row] = db.table('trip_plans');
    const stored = row.recommendations as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['activities', 'overview', 'restaurants', 'tips']);
    expect((stored.restaurants as unknown[]).length).toBe(8);
    expect((stored.tips as unknown[]).length).toBe(6);
    expect(stored.restaurants).toEqual(parseTripResearch(JSON.stringify(padded))!.restaurants);
  });
});

describe('reading saved trip plans', () => {
  const plan = (id: string, recommendations: unknown) => ({
    id, family_id: 'fam-1', created_by: 'user-1', event_id: null, title: `Trip ${id}`, destination: 'Somewhere', dest_lat: null, dest_lng: null,
    start_date: null, end_date: null, members: [], interests: null, recommendations, weather_summary: null, status: 'active', created_at: `2026-10-0${id}T00:00:00.000Z`,
  });

  it('a row holding the column\'s default `{}` reaches the card as an empty set, beside a well-formed one', async () => {
    db.seed('trip_plans', [plan('1', {}), plan('2', wellFormed)]);
    renderToStaticMarkup(await TripIntelPage());
    const props = io.moduleProps as { tripPlans: { id: string; recommendations: unknown }[] };
    expect(props.tripPlans.map((p) => p.id)).toEqual(['2', '1']);
    expect(props.tripPlans.find((p) => p.id === '1')!.recommendations).toEqual(emptyTripRecommendations());
    expect(props.tripPlans.find((p) => p.id === '2')!.recommendations).toEqual(normalizeTripRecommendations(wellFormed));
  });
});
