import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, change, click, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Smart Departure's rush hour was the DEVICE's.
//
// `trafficFactorForTime` read the event's weekday and hour with getDay() and
// getHours(), the clock of whatever phone or laptop asked. Trip Intelligence
// is a family page: a Tokyo family's 08:30 Tuesday school run, planned or
// refreshed by a parent whose phone is still on New York time (or by the CI
// host on UTC), was priced as Monday 19:30 or 23:30, and the leave-by, the
// "Head out" calendar event and every member's reminder were built on the
// wrong traffic. The factor is now read on the family's clock.
//
// Asia/Tokyo is used on purpose: CI runs the suite under UTC and under
// America/Los_Angeles, and 23:30Z is neither one's morning rush.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const calls = vi.hoisted(() => ({ refresh: [] as { trafficFactor: number }[], save: [] as { trafficFactor: number }[] }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock('@/lib/trips/routing', async (original) => ({ ...(await original<object>()), driveEstimate: async () => ({ seconds: 1200, meters: 16000 }) }));
vi.mock('@/lib/weather/open-meteo', async (original) => ({ ...(await original<object>()), fetchForecast: async () => null, geocodeCity: async () => [{ latitude: 35.68, longitude: 139.76 }] }));
vi.mock('@/app/(app)/dashboard/trip-intel/actions', () => ({
  saveTripPlanAction: async () => ({ ok: true }), deleteTripPlanAction: async () => ({ ok: true }),
  saveDeparturePlanAction: async (input: { trafficFactor: number }) => { calls.save.push(input); return { ok: true, data: { id: 'dep-2', leaveBy: '2026-10-26T23:00:00Z' } }; },
  deleteDeparturePlanAction: async () => ({ ok: true }),
  refreshDeparturePlanAction: async (input: { trafficFactor: number }) => { calls.refresh.push(input); return { ok: true, data: { leaveBy: '2026-10-26T23:00:00Z' } }; },
}));

const { trafficFactorForTime } = await import('@/lib/trips/departure');
const { TripIntelModule } = await import('@/components/modules/trip-intel-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
// Tuesday 27 October 2026, 08:30 in Tokyo: Monday 23:30 UTC, Monday 16:30 in Los Angeles.
const SCHOOL_RUN = '2026-10-26T23:30:00Z';

describe('trafficFactorForTime reads the family\'s clock', () => {
  it('prices a Tokyo family\'s 08:30 Tuesday as the morning peak', () => {
    expect(trafficFactorForTime(SCHOOL_RUN, 'Asia/Tokyo')).toBeCloseTo(1.45);
  });
  it('and the same instant in Los Angeles as the evening peak, in UTC as overnight', () => {
    expect(trafficFactorForTime(SCHOOL_RUN, 'America/Los_Angeles')).toBeCloseTo(1.5);
    expect(trafficFactorForTime(SCHOOL_RUN, 'UTC')).toBe(1);
  });
  it('reads the weekday on that clock too: Saturday 08:30 in Tokyo is a free road', () => {
    // Friday 23:30 UTC is a weekday rush hour nowhere near Tokyo's Saturday.
    expect(trafficFactorForTime('2026-10-30T23:30:00Z', 'Asia/Tokyo')).toBe(1);
  });
  it('still answers 1 for a time it cannot read', () => {
    expect(trafficFactorForTime('not-a-date', 'Asia/Tokyo')).toBe(1);
  });
});

describe('a saved departure is refreshed on the family\'s clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    resetHookSlots(h.hooks);
    h.toasts = { success: [], error: [] };
    h.timeZone = 'Asia/Tokyo';
    calls.refresh = []; calls.save = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('sends the Tokyo morning-peak factor whatever the device\'s zone', async () => {
    const element = () => createElement(TripIntelModule, {
      upcoming: [], memberOptions: [], tripPlans: [], tablesMissing: false,
      departurePlans: [{
        id: 'dep-1', title: 'School run', origin: 'Home', destination: 'School', eventStart: SCHOOL_RUN,
        prepMinutes: 10, parkMinutes: 5, bufferMinutes: 5, driveSeconds: 1200, trafficFactor: 1, weatherDelayMinutes: 0,
        weatherSummary: null, leaveBy: '2026-10-26T23:00:00Z', lastCheckedAt: null,
        destLat: 35.68, destLng: 139.76, originLat: 35.66, originLng: 139.70,
      }],
    });
    await click(byName(render(h.hooks, element()), t('tripIntel.refreshLiveIntel')));

    expect(calls.refresh).toHaveLength(1);
    expect(calls.refresh[0].trafficFactor).toBeCloseTo(1.45);
  });

  it('plans and saves a new departure with the Tokyo morning-peak factor', async () => {
    const element = () => createElement(TripIntelModule, {
      memberOptions: [], tripPlans: [], departurePlans: [], tablesMissing: false,
      upcoming: [{ id: 'ev-1', title: 'School run', location: 'School', startsAt: SCHOOL_RUN, allDay: false, category: 'school', memberName: null }],
    });
    await click(byName(render(h.hooks, element()), new RegExp(t('tripIntel.planDeparture'))));
    change(nodes(render(h.hooks, element())).find((n) => n.type === 'input' && n.props.placeholder === t('tripIntel.eG123MainStAtlanta')) as Node, 'Home');
    await click(byName(render(h.hooks, element()), /Calculate when to leave/));
    await click(byName(render(h.hooks, element()), new RegExp(t('tripIntel.addLdquoHeadOutRdquoTo'))));

    expect(calls.save).toHaveLength(1);
    expect(calls.save[0].trafficFactor).toBeCloseTo(1.45);
  });
});
