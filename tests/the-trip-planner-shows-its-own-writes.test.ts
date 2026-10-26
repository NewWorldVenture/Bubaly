import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { REALTIME_TABLES } from '@/lib/realtime/published-tables';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Trip Planner (/dashboard/trips, components/modules/trips-module.tsx)
// never showed its own writes.
//
// `trips` and `trip_items` are not in the realtime publication, so the hook
// opens no channel for them (lib/realtime/published-tables.ts) and the screen
// changes only when the component re-reads. It never did:
//   - a parent ticking "Passports" saw the box stay empty; the next tap wrote
//     `is_done = true` AGAIN (from the stale row), so the box could not be
//     ticked, or unticked, without a reload;
//   - "Trip created" and "Item added" were toasted over a list that did not
//     change, so the natural next move, pressing Create again, saved a second
//     copy;
//   - a removed item or a deleted trip stayed on screen, and removing it again
//     matched nothing and said "That change was not saved".
//
// This drives the REAL module through tests/helpers/module-harness.tsx, whose
// realtime hook changes the screen only when the component asks, which is the
// real hook's behaviour for an unpublished table.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { TripsModule } = await import('@/components/modules/trips-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({
    defaults: {
      trips: { status: 'planning', traveler_ids: [], notes: null, destination: null },
      trip_items: { is_done: false, details: null, assignee_id: null, sort_order: 0, due_at: null },
    },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(TripsModule));
const tripCard = (tree: ReactNode, name: string) => nodes(tree).find((n) => n.type === 'button' && has(n, name)) as Node;
const tick = (tree: ReactNode, label: string) => byName(tree, label);

function seedLakeWeek(items: Record<string, unknown>[] = []) {
  db.seed('trips', [{ id: 'trip-1', family_id: FAMILY, name: 'Lake week', start_date: '2026-11-07', end_date: '2026-11-14', status: 'planning', traveler_ids: [] }]);
  db.seed('trip_items', items.map((item, i) => ({ family_id: FAMILY, trip_id: 'trip-1', kind: 'packing', sort_order: i, is_done: false, ...item })));
}

async function openLakeWeek(): Promise<ReactNode> {
  await click(tripCard(screen(), 'Lake week'));
  return screen();
}

describe('the Trip Planner shows its own writes', () => {
  it('relies on a re-read: neither table is realtime-published', () => {
    expect(REALTIME_TABLES.has('trips')).toBe(false);
    expect(REALTIME_TABLES.has('trip_items')).toBe(false);
  });

  it('a ticked item shows ticked, and the second tap unticks it instead of writing "done" again', async () => {
    seedLakeWeek([{ id: 'item-1', label: 'Passports' }]);

    await click(tick(await openLakeWeek(), t('uiText.markDone')));
    expect(db.table('trip_items')[0].is_done).toBe(true);

    const after = screen();
    expect(nodes(after).some((n) => n.props['aria-label'] === t('uiText.markNotDone'))).toBe(true);
    await click(tick(after, t('uiText.markNotDone')));

    expect(db.table('trip_items')[0].is_done).toBe(false);
    expect(h.toasts.error).toEqual([]);
  });

  it('a created trip appears on the list, so nobody creates it twice', async () => {
    await click(byName(screen(), new RegExp(t('trips.newTrip'))));
    change(nodes(screen()).find((n) => n.type === 'input' && n.props.placeholder === t('trips.eGSummerAtTheLake')) as Node, 'Ski weekend');
    await submit(form(screen()));

    expect(db.table('trips').map((row) => row.name)).toEqual(['Ski weekend']);
    expect(has(screen(), 'Ski weekend')).toBe(true);
  });

  it('an edited trip shows its new name', async () => {
    seedLakeWeek();
    await click(byName(await openLakeWeek(), t('trips.editTrip')));
    change(nodes(screen()).find((n) => n.type === 'input' && n.props.placeholder === t('trips.eGSummerAtTheLake')) as Node, 'Lake week (long)');
    await submit(form(screen()));

    expect(db.table('trips')[0].name).toBe('Lake week (long)');
    expect(has(screen(), 'Lake week (long)')).toBe(true);
  });

  it('an added checklist item appears', async () => {
    seedLakeWeek();
    const detail = await openLakeWeek();
    await click(nodes(detail).filter((n) => n.type === 'button' && has(n, 'Add'))[0]);
    change(nodes(screen()).find((n) => n.type === 'input' && n.props.placeholder === t('trips.eGPassportsSunscreenHotelCheck')) as Node, 'Sunscreen');
    await submit(form(screen()));

    expect(db.table('trip_items').map((row) => row.label)).toEqual(['Sunscreen']);
    expect(has(screen(), 'Sunscreen')).toBe(true);
  });

  it('a removed item leaves the checklist', async () => {
    seedLakeWeek([{ id: 'item-1', label: 'Passports' }]);
    await click(byName(await openLakeWeek(), t('trips.remove')));

    expect(db.table('trip_items')).toEqual([]);
    expect(has(screen(), 'Passports')).toBe(false);
    expect(h.toasts.error).toEqual([]);
  });

  it('a deleted trip leaves the list', async () => {
    seedLakeWeek([{ id: 'item-1', label: 'Passports' }]);
    await click(byName(await openLakeWeek(), t('trips.deleteTrip')));

    expect(db.table('trips')).toEqual([]);
    expect(has(screen(), 'Lake week')).toBe(false);
    expect(h.toasts.error).toEqual([]);
  });
});
