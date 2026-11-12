// Call-level role tests for the Auto & Vehicles server actions
// (app/(app)/dashboard/auto/actions.ts), Register B group 2.
//
// THE POLICY, from the sources the audit names:
//   - The seven auto tables are written under 0037's family loop
//     (supabase/migrations/0037_auto.sql:226-245): any member of the row's
//     family may insert, update and delete. Nothing later narrows vehicles,
//     registrations, inspections, insurance policies, rentals or the service
//     log; no guest guard (0464, 0481) names them.
//   - driver_licenses alone is narrowed: since 0297
//     (supabase/migrations/0297_sensitive_tables_respect_role.sql:100-123) a
//     licence is written by a manager, or by the member it names.
//   - The actions add no role check of their own. What they add is the family
//     filter (`.eq('family_id', …)` on every update and soft delete), a
//     zero-rows check on both, a refusal to edit an already-deleted record, and
//     an explicit same-family check on the service log's vehicle.
//
// WHAT IS PINNED: a parent and an adult (isManager, lib/constants/roles.ts:56)
// save, edit and delete every record kind and the rows read back as promised;
// an id from household B is refused with `notSaved` and neither household
// changes; a signed-out caller is sent away before anything is written; and
// on licences the 0297 policy, modelled on the client the action is handed
// (the fake does not run RLS), is refused for a non-manager writing someone
// else's licence and allowed for their own.
//
// NOT PINNED (the PR lists them): teen, child and caregiver writes on the six
// unnarrowed tables (0464:46-52 records them as the owner's call), every
// guest write (a defect on insurance, which lib/auth/guest-scope.ts:50
// withholds from a guest; the owner's call elsewhere), and the missing plan
// gate (the pages require Basic, the actions require nothing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { isManager } from '@/lib/constants/roles';

const h = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  signedOut: false,
  revalidate: [] as string[],
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (h.signedOut) throw new Error('NEXT_REDIRECT:/login');
    return h.ctx;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { h.revalidate.push(path); } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const auto = await import('@/app/(app)/dashboard/auto/actions');

const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0b000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const memberOf = (role: Role) => `${String(ROLES.indexOf(role) + 1).padStart(8, '0')}-0000-4000-8000-0000000000a1`;
const userOf = (role: Role) => `${String(ROLES.indexOf(role) + 1).padStart(8, '0')}-0000-4000-8000-0000000000a2`;
const B_PARENT_MEMBER = '00000009-0000-4000-8000-0000000000b1';

const VEHICLE_A = 'a1000000-0000-4000-8000-000000000001';
const VEHICLE_B = 'b1000000-0000-4000-8000-000000000001';

let db: InMemorySupabase;

function signInAs(role: Role) {
  h.signedOut = false;
  h.ctx = {
    user: { id: userOf(role), email: `${role}@example.com` },
    memberships: [],
    active: { familyId: A, role, member: { id: memberOf(role) }, family: { id: A, name: 'Household A', timezone: 'America/New_York' } },
  };
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

type Kind = {
  name: string;
  table: string;
  saveId: string;
  deleteId: string;
  save: (fd: FormData) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  /** What the form sends, and what the row must then hold. */
  fields: Record<string, string>;
  written: Record<string, unknown>;
  /** The columns a soft delete must blank. */
  scrubbed: string[];
  /** A row as seeded in either household, with identifying values. */
  seed: (family: string) => Record<string, unknown>;
  /** Whether a save with an id edits that row (the service log only inserts). */
  edits: boolean;
};

const KINDS: Kind[] = [
  {
    name: 'vehicle', table: 'vehicles', saveId: 'ACTION-5642CA924329', deleteId: 'ACTION-9771EF95BAD4',
    save: auto.saveVehicleAction, remove: auto.deleteVehicleAction,
    fields: { nickname: 'Blue van', make: 'Example Motors', year: '2020', vin: 'VIN-NEW' },
    written: { nickname: 'Blue van', make: 'Example Motors', year: 2020, vin: 'VIN-NEW', status: 'active' },
    scrubbed: ['vin', 'license_plate', 'notes'],
    seed: (family) => ({ nickname: 'Old car', vin: `VIN-${family}`, license_plate: 'PLATE-1', notes: 'kept', mileage: 100 }),
    edits: true,
  },
  {
    name: 'licence', table: 'driver_licenses', saveId: 'ACTION-F585F63E9A52', deleteId: 'ACTION-FD39CA24A649',
    save: auto.saveLicenseAction, remove: auto.deleteLicenseAction,
    fields: { holder_name: 'Pat Example', license_number: 'D-0001', state: 'NY' },
    written: { holder_name: 'Pat Example', license_number: 'D-0001', state: 'NY', status: 'active' },
    scrubbed: ['license_number', 'notes'],
    seed: () => ({ holder_name: 'Holder', license_number: 'D-SEEDED', notes: 'kept', member_id: null }),
    edits: true,
  },
  {
    name: 'registration', table: 'vehicle_registrations', saveId: 'ACTION-BF505BA2DE64', deleteId: 'ACTION-F1A91EBA9C09',
    save: auto.saveRegistrationAction, remove: auto.deleteRegistrationAction,
    fields: { plate: 'NEW-123', state: 'NY', fee: '80' },
    written: { plate: 'NEW-123', state: 'NY', fee: 80, status: 'active' },
    scrubbed: ['plate', 'notes'],
    seed: () => ({ plate: 'OLD-999', notes: 'kept' }),
    edits: true,
  },
  {
    name: 'inspection', table: 'vehicle_inspections', saveId: 'ACTION-9690C67725E8', deleteId: 'ACTION-F8BC27963E70',
    save: auto.saveInspectionAction, remove: auto.deleteInspectionAction,
    fields: { station: 'Example Garage', result: 'pass' },
    written: { station: 'Example Garage', result: 'pass', inspection_type: 'safety' },
    scrubbed: ['station', 'notes'],
    seed: () => ({ station: 'Old Garage', notes: 'kept', inspection_type: 'safety' }),
    edits: true,
  },
  {
    name: 'insurance policy', table: 'auto_insurance_policies', saveId: 'ACTION-C63C3FAC0ABE', deleteId: 'ACTION-87CA12F1EDEA',
    save: auto.savePolicyAction, remove: auto.deletePolicyAction,
    fields: { provider: 'Example Mutual', policy_number: 'P-0001', premium: '120', is_active: 'on' },
    written: { provider: 'Example Mutual', policy_number: 'P-0001', premium: 120, is_active: true, status: 'active' },
    scrubbed: ['policy_number', 'agent_name', 'agent_phone', 'notes'],
    seed: () => ({ provider: 'Old Mutual', policy_number: 'P-SEEDED', agent_name: 'Agent', agent_phone: '555-0100', notes: 'kept' }),
    edits: true,
  },
  {
    name: 'rental', table: 'rental_cars', saveId: 'ACTION-F3975BE4A793', deleteId: 'ACTION-4D7C1C060966',
    save: auto.saveRentalAction, remove: auto.deleteRentalAction,
    // 9am on 1 December in New York is 14:00Z.
    fields: { company: 'Example Rentals', confirmation_number: 'CONF-1', pickup_at: '2026-12-01T09:00' },
    written: { company: 'Example Rentals', confirmation_number: 'CONF-1', pickup_at: '2026-12-01T14:00:00.000Z', status: 'upcoming' },
    scrubbed: ['confirmation_number', 'notes'],
    seed: () => ({ company: 'Old Rentals', confirmation_number: 'CONF-SEEDED', notes: 'kept' }),
    edits: true,
  },
  {
    name: 'service record', table: 'auto_service_records', saveId: 'ACTION-AC57AA6F6AF5', deleteId: 'ACTION-E31F2050163D',
    save: auto.saveAutoServiceAction, remove: auto.deleteAutoServiceAction,
    fields: { title: 'Oil change', service_date: '2026-11-01', provider: 'Example Garage', cost: '60' },
    written: { title: 'Oil change', service_date: '2026-11-01', provider: 'Example Garage', cost: 60 },
    scrubbed: ['provider', 'description'],
    seed: () => ({ title: 'Old service', provider: 'Old Garage', description: 'kept' }),
    edits: false,
  },
];

const rowId = (kind: Kind, family: string, n = 1) =>
  `${family === A ? 'a' : 'b'}${String(KINDS.indexOf(kind) + 2)}000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.revalidate = [];
  h.signedOut = false;
  // Both households are on an active Plus plan, the highest tier the catalogue
  // gives /dashboard/auto (lib/constants/feature-catalog.ts:132), so the cases
  // below stay true once the actions check the plan the pages already require.
  db.seed('subscriptions', [
    { family_id: A, plan: 'plus', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z' },
    { family_id: B, plan: 'plus', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z' },
  ]);
  db.seed('vehicles', [
    { id: VEHICLE_A, family_id: A, nickname: 'Family car', mileage: 1000, deleted_at: null },
    { id: VEHICLE_B, family_id: B, nickname: 'Their car', mileage: 5000, deleted_at: null },
  ]);
  for (const kind of KINDS) {
    db.seed(kind.table, [
      { id: rowId(kind, A), family_id: A, ...kind.seed(A), deleted_at: null },
      { id: rowId(kind, B), family_id: B, ...kind.seed(B), deleted_at: null },
      { id: rowId(kind, A, 2), family_id: A, ...kind.seed(A), deleted_at: '2026-01-01T00:00:00.000Z' },
    ]);
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const snapshot = () => structuredClone(Object.fromEntries(
  KINDS.map((k) => [k.table, db.table(k.table)] as const),
));
const familyRows = (table: string, family: string) => db.table(table).filter((r) => r.family_id === family);

describe.each(KINDS)('the $name actions', (kind) => {
  describe.each(['parent', 'adult'] as const)('for a %s of household A', (role) => {
    it(`${kind.saveId} saves a new record into household A only, attributed to the caller`, async () => {
      signInAs(role);
      const theirs = structuredClone(familyRows(kind.table, B));
      const before = familyRows(kind.table, A).length;
      await expect(kind.save(form(kind.fields))).resolves.toBeUndefined();
      const mine = familyRows(kind.table, A);
      expect(mine).toHaveLength(before + 1);
      expect(mine.at(-1)).toMatchObject({ ...kind.written, family_id: A, created_by: userOf(role) });
      expect(familyRows(kind.table, B)).toEqual(theirs);
      expect(h.revalidate).toContain('/dashboard/auto');
    });

    it(`${kind.deleteId} soft-deletes the household's own record and blanks what identified it`, async () => {
      signInAs(role);
      await expect(kind.remove(rowId(kind, A))).resolves.toBeUndefined();
      const row = db.table(kind.table).find((r) => r.id === rowId(kind, A));
      expect(row?.deleted_at).toEqual(expect.any(String));
      expect(row?.updated_by).toBe(userOf(role));
      expect(Object.fromEntries(kind.scrubbed.map((c) => [c, row?.[c]]))).toEqual(Object.fromEntries(kind.scrubbed.map((c) => [c, null])));
    });
  });

  it(`${kind.deleteId} refuses household B's record id, and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    const refused = kind.remove(rowId(kind, B));
    await expect(refused).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(snapshot()).toEqual(before);
    expect(h.revalidate).toEqual([]);
  });

  it(`${kind.saveId} and ${kind.deleteId} send a signed-out caller away before anything is written`, async () => {
    h.signedOut = true;
    const before = snapshot();
    await expect(kind.save(form({ ...kind.fields, id: rowId(kind, A) }))).rejects.toThrow('NEXT_REDIRECT:/login');
    await expect(kind.remove(rowId(kind, A))).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});

describe.each(KINDS.filter((k) => k.edits))('editing a $name', (kind) => {
  it.each(['parent', 'adult'] as const)(`${kind.saveId} edits household A's record in place for a %s`, async (role) => {
    signInAs(role);
    const count = db.table(kind.table).length;
    await expect(kind.save(form({ ...kind.fields, id: rowId(kind, A) }))).resolves.toBeUndefined();
    expect(db.table(kind.table)).toHaveLength(count);
    expect(db.table(kind.table).find((r) => r.id === rowId(kind, A))).toMatchObject({ ...kind.written, family_id: A, updated_by: userOf(role) });
  });

  it(`${kind.saveId} refuses household B's record id, and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    const refused = kind.save(form({ ...kind.fields, id: rowId(kind, B) }));
    await expect(refused).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(snapshot()).toEqual(before);
    expect(h.revalidate).toEqual([]);
  });

  it(`${kind.saveId} refuses an edit of a record household A already deleted`, async () => {
    signInAs('parent');
    const before = snapshot();
    await expect(kind.save(form({ ...kind.fields, id: rowId(kind, A, 2) }))).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(snapshot()).toEqual(before);
  });
});

describe('ACTION-AC57AA6F6AF5 the service log and its vehicle', () => {
  it.each(['parent', 'adult'] as const)("ACTION-AC57AA6F6AF5 logs a service on household A's vehicle and moves its odometer forward for a %s", async (role) => {
    signInAs(role);
    await expect(auto.saveAutoServiceAction(form({ vehicle_id: VEHICLE_A, title: 'Tyres', mileage: '1500' }))).resolves.toBeUndefined();
    expect(familyRows('auto_service_records', A).at(-1)).toMatchObject({ vehicle_id: VEHICLE_A, title: 'Tyres', mileage: 1500, family_id: A, created_by: userOf(role) });
    expect(db.table('vehicles').find((v) => v.id === VEHICLE_A)?.mileage).toBe(1500);
  });

  it("ACTION-AC57AA6F6AF5 refuses household B's vehicle id, writes no record and leaves B's odometer alone", async () => {
    signInAs('parent');
    const before = snapshot();
    const refused = auto.saveAutoServiceAction(form({ vehicle_id: VEHICLE_B, title: 'Tyres', mileage: '9000' }));
    await expect(refused).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(snapshot()).toEqual(before);
    expect(db.table('vehicles').find((v) => v.id === VEHICLE_B)?.mileage).toBe(5000);
  });
});

/**
 * The 0297 licence policy on the client the action is handed, since the fake
 * runs no RLS: for a non-manager an INSERT naming another member raises 42501
 * (WITH CHECK), and an UPDATE sees only rows naming them (USING), so a write to
 * anyone else's licence matches nothing.
 * supabase/migrations/0297_sensitive_tables_respect_role.sql:100-123.
 */
function underLicencePolicy(store: InMemorySupabase, role: Role): InMemorySupabase {
  const self = memberOf(role);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 'driver_licenses' || isManager(role)) return builder;
        const insert = builder.insert.bind(builder);
        const update = builder.update.bind(builder);
        return Object.assign(builder, {
          insert: (row: Record<string, unknown>) => (row.member_id === self ? insert(row) : {
            then: (resolve: (v: unknown) => unknown) => Promise.resolve({
              data: null, count: null, status: 403, statusText: 'Forbidden',
              error: { code: '42501', message: 'new row violates row-level security policy for table "driver_licenses"', details: null, hint: null },
            }).then(resolve),
          }),
          update: (patch: Record<string, unknown>) => update(patch).eq('member_id', self),
        });
      };
    },
  });
}

describe('driver licences under the 0297 policy (pinned (RLS))', () => {
  const NON_MANAGERS = ['teen', 'child', 'caregiver'] as const;
  const PARENTS_LICENCE = 'a3000000-0000-4000-8000-0000000000aa';

  beforeEach(() => {
    db.seed('driver_licenses', [{ id: PARENTS_LICENCE, family_id: A, member_id: memberOf('parent'), holder_name: 'Parent', license_number: 'D-PARENT', notes: null, deleted_at: null }]);
  });

  it.each(NON_MANAGERS)('ACTION-F585F63E9A52 lets a %s save their own licence', async (role) => {
    signInAs(role);
    h.db = underLicencePolicy(db, role);
    await expect(auto.saveLicenseAction(form({ member_id: memberOf(role), holder_name: 'Me', license_number: 'D-MINE' }))).resolves.toBeUndefined();
    expect(familyRows('driver_licenses', A).at(-1)).toMatchObject({ member_id: memberOf(role), license_number: 'D-MINE', created_by: userOf(role) });
  });

  it.each(NON_MANAGERS)("ACTION-F585F63E9A52 surfaces the refusal when a %s saves a licence naming someone else, and writes nothing", async (role) => {
    signInAs(role);
    h.db = underLicencePolicy(db, role);
    const before = snapshot();
    await expect(auto.saveLicenseAction(form({ member_id: memberOf('parent'), holder_name: 'Parent', license_number: 'D-FORGED' })))
      .rejects.toMatchObject({ digest: 'ACTION_REFUSED:notAllowed' });
    await expect(auto.saveLicenseAction(form({ id: PARENTS_LICENCE, member_id: memberOf('parent'), license_number: 'D-FORGED' })))
      .rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(snapshot()).toEqual(before);
  });

  it.each(NON_MANAGERS)("ACTION-FD39CA24A649 refuses a %s deleting a parent's licence, and the number stays", async (role) => {
    signInAs(role);
    h.db = underLicencePolicy(db, role);
    await expect(auto.deleteLicenseAction(PARENTS_LICENCE)).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notSaved' });
    expect(db.table('driver_licenses').find((r) => r.id === PARENTS_LICENCE)).toMatchObject({ license_number: 'D-PARENT', deleted_at: null });
  });

  it.each(['parent', 'adult'] as const)("ACTION-F585F63E9A52 lets a %s write any member's licence", async (role) => {
    signInAs(role);
    h.db = underLicencePolicy(db, role);
    await expect(auto.saveLicenseAction(form({ member_id: memberOf('teen'), holder_name: 'Teen', license_number: 'D-TEEN' }))).resolves.toBeUndefined();
    expect(familyRows('driver_licenses', A).at(-1)).toMatchObject({ member_id: memberOf('teen'), license_number: 'D-TEEN' });
  });
});
