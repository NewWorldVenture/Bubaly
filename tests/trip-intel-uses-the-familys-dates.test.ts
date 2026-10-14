// Trip Intelligence plans on the FAMILY's date (N18).
//
// Trip dates and the forecast day were the UTC date of the start: a 19:00 Los
// Angeles game (02:00Z the next day) was researched, saved and forecast for
// the following day. And an all-day event — a DATE stored at its UTC midnight
// — was offered for departure planning as if it began at that midnight, which
// west of Greenwich writes a head-out for the evening before.
//
// Driven through the real module's own handlers (tests/helpers/module-harness.tsx).
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allByName, byName, click, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { weatherInfo } from '@/lib/weather/open-meteo';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const io = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[], asked: [] as Record<string, unknown>[] }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/app/(app)/dashboard/trip-intel/actions', () => ({
  saveTripPlanAction: async (input: Record<string, unknown>) => { io.saved.push(input); return { ok: true, data: { id: 'trip-1' } }; },
  deleteTripPlanAction: async () => ({ ok: true }),
  saveDeparturePlanAction: async () => ({ ok: true }),
  refreshDeparturePlanAction: async () => ({ ok: true }),
  deleteDeparturePlanAction: async () => ({ ok: true }),
}));
vi.mock('@/lib/weather/open-meteo', async (original) => ({
  ...(await original<object>()),
  geocodeCity: async () => [{ latitude: 34.05, longitude: -118.24, name: 'Los Angeles' }],
  // Clear on Thursday the 15th (the family's date of the game), rain on the 16th.
  fetchForecast: async () => ({ daily: [
    { date: '2026-10-15', code: 0, tempMax: 24, tempMin: 15, precipProb: 0 },
    { date: '2026-10-16', code: 63, tempMax: 18, tempMin: 12, precipProb: 90 },
  ] }),
}));

const { TripIntelModule } = await import('@/components/modules/trip-intel-module');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const upcoming = [
  // Thursday 15 October, 19:00 in Los Angeles.
  { id: 'game', title: 'Night game', location: 'Dodger Stadium', startsAt: '2026-10-16T02:00:00.000Z', allDay: false, category: 'sports', memberName: null },
  // Saturday 17 October, all day.
  { id: 'fair', title: 'Street fair', location: 'Main St', startsAt: '2026-10-17T00:00:00.000Z', allDay: true, category: 'general', memberName: null },
];
const view = () => createElement(TripIntelModule, { upcoming, memberOptions: [], tripPlans: [], departurePlans: [], tablesMissing: false });

beforeEach(() => {
  io.saved = []; io.asked = [];
  resetHookSlots(h.hooks);
  h.timeZone = 'America/Los_Angeles';
  h.toasts = { success: [], error: [] };
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    io.asked.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true, json: async () => ({ recommendations: { overview: 'Fun', restaurants: [], activities: [], tips: [] }, source: 'ai' }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Trip Intelligence on the family\'s calendar', () => {
  it('offers no departure plan for an all-day event, which has no time to arrive by', () => {
    const tree = render(h.hooks, view());
    expect(allByName(tree, t('tripIntel.research'))).toHaveLength(2);
    expect(allByName(tree, t('tripIntel.planDeparture'))).toHaveLength(1);
  });

  it('researches, forecasts and saves an evening game on the family\'s date', async () => {
    let tree = render(h.hooks, view());
    await click(allByName(tree, t('tripIntel.research'))[0]);
    tree = render(h.hooks, view());
    await click(byName(tree, 'Research this destination'));
    await settle();
    tree = render(h.hooks, view());
    expect(io.asked).toEqual([expect.objectContaining({ startDate: '2026-10-15' })]);
    expect(String(io.asked[0].weatherSummary)).toContain(weatherInfo(0, true).label);
    await click(byName(tree, t('tripIntel.saveTrip')));
    expect(io.saved).toEqual([expect.objectContaining({ startDate: '2026-10-15', eventId: 'game' })]);
  });
});
