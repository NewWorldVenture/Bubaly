// Auto's "Upcoming renewals" kept nagging about what the family had moved past.
//
// `getAutoOverview` passed every live registration, inspection and policy to
// `buildRenewals`, so the overview listed, and counted in "Renewals due (30d)":
// - a policy unticked as "Active policy" after the family switched insurers,
//   first "Renew in Nd", then "Expired Nd ago", for good;
// - the registration, inspection and policy of a car marked Sold, or of a car
//   the family deleted (the soft delete does not reach its child rows);
// - last year's registration beside the renewed one added as a new record.
// The only way to clear the count was to delete the history.
//
// A renewal is a record still in force for a car still on the road: not an
// inactive policy, not a sold or removed vehicle's record, and not a
// registration (per vehicle) or inspection (per vehicle and type) that a
// later-expiring one has replaced.
import { describe, expect, it, vi } from 'vitest';
import { buildRenewals, dueSoonCount } from '@/lib/auto/renewals';

const TODAY = '2026-10-25';
const vehicleName = (id: string | null) => (id ? `Car ${id}` : null);

function sources(over: Partial<Parameters<typeof buildRenewals>[0]> = {}): Parameters<typeof buildRenewals>[0] {
  return { licenses: [], registrations: [], inspections: [], policies: [], vehicleName, todayKey: TODAY, ...over };
}

describe('an insurance policy the family no longer has', () => {
  it('is not a renewal once it is marked inactive', () => {
    const items = buildRenewals(sources({
      policies: [
        { id: 'old', provider: 'Old Insurer', vehicle_id: 'v1', expires_on: '2026-10-01', is_active: false },
        { id: 'new', provider: 'New Insurer', vehicle_id: 'v1', expires_on: '2027-04-01', is_active: true },
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['new']);
    expect(dueSoonCount(items, 30)).toBe(0);
  });

  it('still is when active, or when the flag is not known', () => {
    const items = buildRenewals(sources({
      policies: [
        { id: 'a', provider: 'A', vehicle_id: 'v1', expires_on: '2026-11-01', is_active: true },
        { id: 'b', provider: 'B', vehicle_id: null, expires_on: '2026-11-02' },
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('a car the family sold or removed', () => {
  const onTheRoad = new Set(['v1', 'stored']);
  const currentVehicle = (id: string) => onTheRoad.has(id);

  it("drops the car's registration, inspection and policy", () => {
    const items = buildRenewals(sources({
      registrations: [{ id: 'reg-sold', vehicle_id: 'sold', expires_on: '2026-11-01' }, { id: 'reg-v1', vehicle_id: 'v1', expires_on: '2026-11-05' }],
      inspections: [{ id: 'insp-gone', vehicle_id: 'gone', expires_on: '2026-10-20', inspection_type: 'safety' }],
      policies: [{ id: 'pol-sold', provider: 'P', vehicle_id: 'sold', expires_on: '2026-10-30', is_active: true }],
      currentVehicle,
    }));
    expect(items.map((i) => i.id)).toEqual(['reg-v1']);
    expect(dueSoonCount(items, 30)).toBe(1);
  });

  it('keeps a stored car, a record with no car, and every licence', () => {
    const items = buildRenewals(sources({
      licenses: [{ id: 'lic', holder_name: 'Pat', expires_on: '2026-12-01' }],
      registrations: [{ id: 'reg-stored', vehicle_id: 'stored', expires_on: '2026-11-01' }],
      policies: [{ id: 'umbrella', provider: 'P', vehicle_id: null, expires_on: '2026-11-15', is_active: true }],
      currentVehicle,
    }));
    expect(items.map((i) => i.id)).toEqual(['reg-stored', 'umbrella', 'lic']);
  });
});

describe('a registration or inspection renewed as a new record', () => {
  it('lists the renewal, not the registration it replaced', () => {
    const items = buildRenewals(sources({
      registrations: [
        { id: 'reg-2025', vehicle_id: 'v1', expires_on: '2026-10-10' },
        { id: 'reg-2026', vehicle_id: 'v1', expires_on: '2027-10-10' },
        { id: 'reg-v2', vehicle_id: 'v2', expires_on: '2026-10-20' },
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['reg-v2', 'reg-2026']);
  });

  it('replaces an inspection only by a later one of the same type', () => {
    const items = buildRenewals(sources({
      inspections: [
        { id: 'safety-old', vehicle_id: 'v1', expires_on: '2026-09-01', inspection_type: 'safety' },
        { id: 'safety-new', vehicle_id: 'v1', expires_on: '2027-09-01', inspection_type: 'safety' },
        { id: 'emissions', vehicle_id: 'v1', expires_on: '2026-10-01', inspection_type: 'emissions' },
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['emissions', 'safety-new']);
  });

  it('does not pair up registrations that name no car', () => {
    const items = buildRenewals(sources({
      registrations: [
        { id: 'a', vehicle_id: null, expires_on: '2026-10-10' },
        { id: 'b', vehicle_id: null, expires_on: '2027-10-10' },
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

// ── the overview reads it that way ──────────────────────────────────────────

const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]> }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from(table: string) {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const builder = {
        select: () => builder,
        eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return builder; },
        is: (col: string, value: unknown) => { filters.push((r) => (r[col] ?? null) === value); return builder; },
        order: () => builder,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve({
          data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null,
        }).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

describe('getAutoOverview', () => {
  it('builds renewals for the cars still on the road only', async () => {
    const fam = { family_id: 'fam', deleted_at: null, created_by: 'parent' };
    db.tables = {
      vehicles: [
        { ...fam, id: 'v1', nickname: 'Daily', status: 'active' },
        { ...fam, id: 'sold', nickname: 'Old van', status: 'sold' },
        { ...fam, id: 'retired', nickname: 'Project car', status: 'retired' },
        { ...fam, id: 'stored', nickname: 'Convertible', status: 'stored' },
        { ...fam, id: 'gone', nickname: 'Wrecked', status: 'active', deleted_at: '2026-09-01T00:00:00Z' },
      ],
      driver_licenses: [],
      vehicle_registrations: [
        { ...fam, id: 'reg-v1', vehicle_id: 'v1', expires_on: '2026-11-05' },
        { ...fam, id: 'reg-sold', vehicle_id: 'sold', expires_on: '2026-11-01' },
        { ...fam, id: 'reg-gone', vehicle_id: 'gone', expires_on: '2026-10-20' },
        { ...fam, id: 'reg-retired', vehicle_id: 'retired', expires_on: '2026-10-21' },
        { ...fam, id: 'reg-stored', vehicle_id: 'stored', expires_on: '2026-11-20' },
      ],
      vehicle_inspections: [],
      auto_insurance_policies: [
        { ...fam, id: 'pol-old', provider: 'Old', vehicle_id: 'v1', expires_on: '2026-10-15', is_active: false },
      ],
      rental_cars: [],
    };
    const { getAutoOverview } = await import('@/lib/auto/queries');
    const { renewals } = await getAutoOverview('fam', { role: 'parent', userId: 'parent' }, TODAY);
    expect(renewals.map((r) => r.id)).toEqual(['reg-v1', 'reg-stored']);
    expect(dueSoonCount(renewals, 30)).toBe(2);
  });
});
