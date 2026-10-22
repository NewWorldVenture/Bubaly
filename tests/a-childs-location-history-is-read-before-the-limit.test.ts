import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N6 — the Family Map and Driving Safety, the REAL modules and their own reads
// against an in-memory database (the held 0516 leaves RLS family-wide).
//
// A child or teen reads only their own location history and trips (lib/
// location/history-scope.ts). Both screens fetched EVERY member's newest 120
// arrivals and departures (200 trips) into the child's browser, kept them live
// over realtime, and narrowed them only for display — so other members' places
// and times sat in the child's network responses, and a busy family's newest
// rows pushed the child's own history out of the cap altogether. The check-in
// page beside them narrows before the limit; these now do too.

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
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/locator/actions', () => ({
  updateMyLocation: vi.fn(), setLocationSharing: vi.fn(), savePlace: vi.fn(), deletePlace: vi.fn(), setGeofenceEnabled: vi.fn(),
}));

const { LocatorModule } = await import('@/components/modules/locator-module');
const { DrivingSafetyView } = await import('@/components/family/driving-safety-view');

const FAMILY = h.app.familyId;
const ME = 'member-me';
const SIB = 'member-sib';
let db: InMemorySupabase;

function as(role: string, self: string | null = ME) {
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = self ? { id: self, display_name: 'Ada', role, is_active: true, color: null, birthday: null } : null;
}

/** Mount, let every read the module started answer, and render the result. */
async function show(Component: () => ReactNode): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(Component));
  for (let i = 0; i < 6; i++) { await settle(); tree = render(h.hooks, createElement(Component)); }
  return tree;
}
/** What the module's own read of `table` answered: the rows that reached the browser. */
const received = (table: string) => Object.entries(h.rows).filter(([key]) => key.startsWith(`${table}:`)).flatMap(([, rows]) => rows);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T18:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.realtime = {};
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  h.app.members = [
    { id: ME, display_name: 'Ada', role: 'child', is_active: true, color: null, birthday: null },
    { id: SIB, display_name: 'Ben', role: 'teen', is_active: true, color: null, birthday: null },
  ];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // A busy week of the sibling's arrivals and departures, all newer than the
  // child's own three.
  db.seed('location_events', [
    ...Array.from({ length: 130 }, (_, i) => ({
      id: `sib-${String(i).padStart(3, '0')}`, family_id: FAMILY, member_id: SIB, place_id: null, place_name: `Ben's spot ${i}`,
      event_type: i % 2 ? 'left' : 'arrived', occurred_at: new Date(Date.parse('2026-10-13T17:00:00Z') - i * 60_000).toISOString(),
    })),
    ...['Library', 'School', 'Home'].map((place, i) => ({
      id: `me-${i}`, family_id: FAMILY, member_id: ME, place_id: null, place_name: place,
      event_type: 'arrived', occurred_at: `2026-10-1${i}T08:00:00Z`,
    })),
  ]);
  db.seed('driving_trips', [
    ...Array.from({ length: 210 }, (_, i) => ({
      id: `sib-trip-${String(i).padStart(3, '0')}`, family_id: FAMILY, member_id: SIB, label: `Ben drive ${i}`,
      started_at: new Date(Date.parse('2026-10-13T17:00:00Z') - i * 3_600_000).toISOString(), ended_at: null,
      distance_miles: 5, max_mph: 80, hard_brakes: 3, rapid_accels: 2, phone_use_seconds: 60, score: 40, notes: null, created_by: 'user-sib',
    })),
    ...[0, 1].map((i) => ({
      id: `my-trip-${i}`, family_id: FAMILY, member_id: ME, label: `My drive ${i}`, started_at: `2026-09-0${i + 1}T15:00:00Z`, ended_at: null,
      distance_miles: 3, max_mph: 30, hard_brakes: 0, rapid_accels: 0, phone_use_seconds: 0, score: 95, notes: null, created_by: 'user-1',
    })),
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Family Map reads a child\'s own history, before its limit', () => {
  it.each(['child', 'teen'])('a %s\'s browser receives no other member\'s arrivals or departures', async (role) => {
    as(role);
    await show(LocatorModule);
    const rows = received('location_events');
    expect(rows.filter((r) => r.member_id !== ME)).toEqual([]);
    // And the busy sibling did not push the child's own history out of the cap.
    expect(rows.map((r) => r.place_name).sort()).toEqual(['Home', 'Library', 'School']);
  });

  it('a child with no member record of their own receives nothing', async () => {
    as('child', null);
    await show(LocatorModule);
    expect(received('location_events')).toEqual([]);
  });

  it.each(['parent', 'caregiver'])('a %s still reads everyone\'s', async (role) => {
    as(role);
    await show(LocatorModule);
    const rows = received('location_events');
    expect(rows).toHaveLength(120);
    expect(rows.some((r) => r.member_id === SIB)).toBe(true);
  });
});

describe('Driving Safety reads a teen\'s own trips, before its limit', () => {
  it.each(['child', 'teen'])('a %s\'s browser receives only their own trips, however many others drove', async (role) => {
    as(role);
    await show(DrivingSafetyView);
    const rows = received('driving_trips');
    expect(rows.filter((r) => r.member_id !== ME)).toEqual([]);
    expect(rows.map((r) => r.label).sort()).toEqual(['My drive 0', 'My drive 1']);
  });

  it('a parent still reads everyone\'s', async () => {
    as('parent');
    await show(DrivingSafetyView);
    expect(received('driving_trips')).toHaveLength(200);
  });
});
