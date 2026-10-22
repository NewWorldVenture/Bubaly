// A saved trip's card opens on a recommendation set with no lists in it (U7).
//
// `RecsView` dereferenced `recs.restaurants.length`, `.activities.length` and
// `.tips.length`: a stored row from before the save-time check, or the
// column's own `{}` default, threw on expand and took the dashboard segment to
// its error boundary. A missing list is now an empty one.
//
// The real TripIntelModule, driven through its own handlers
// (tests/helpers/module-harness.tsx).
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock('@/app/(app)/dashboard/trip-intel/actions', () => ({
  saveTripPlanAction: async () => ({ ok: false, error: 'not in this test' }),
  deleteTripPlanAction: async () => ({ ok: false, error: 'not in this test' }),
  saveDeparturePlanAction: async () => ({ ok: false, error: 'not in this test' }),
  refreshDeparturePlanAction: async () => ({ ok: false, error: 'not in this test' }),
  deleteDeparturePlanAction: async () => ({ ok: false, error: 'not in this test' }),
}));

const { TripIntelModule } = await import('@/components/modules/trip-intel-module');

const plan = (recommendations: unknown) => ({
  id: 'plan-1', title: 'Lisbon in June', destination: 'Lisbon', startDate: null, endDate: null, members: [], interests: null,
  weatherSummary: 'Sunny, 24°C', recommendations: recommendations as never, status: 'active',
});
const panel = (recommendations: unknown) => createElement(TripIntelModule, {
  upcoming: [], memberOptions: [], tripPlans: [plan(recommendations)], departurePlans: [], tablesMissing: false,
});
const cardButton = (tree: ReturnType<typeof render>) => nodes(tree).find((n) => n.type === 'button' && text(n).startsWith('Lisbon in June'))!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  h.timeZone = 'America/Los_Angeles';
});
afterEach(() => vi.restoreAllMocks());

describe('expanding a saved trip card', () => {
  it('a set with no lists (the column\'s `{}` default) opens without a throw', async () => {
    let tree = render(h.hooks, panel({}));
    await click(cardButton(tree));
    tree = render(h.hooks, panel({}));
    expect(text(tree)).toContain('Sunny, 24°C');
  });

  it('a set with the lists shows them', async () => {
    const recs = { overview: 'x', restaurants: [{ name: 'Time Out Market', cuisine: 'Portuguese', why: 'Everyone eats.' }], activities: [], tips: ['Book ahead.'] };
    let tree = render(h.hooks, panel(recs));
    await click(cardButton(tree));
    tree = render(h.hooks, panel(recs));
    expect(text(tree)).toContain('Time Out Market');
    expect(text(tree)).toContain('Book ahead.');
  });
});
