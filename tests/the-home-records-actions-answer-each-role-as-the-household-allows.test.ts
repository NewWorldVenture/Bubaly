// Call-level role tests for the seven Home & Maintenance server actions
// (app/(app)/dashboard/home/actions.ts), Register B group 4.
//
// THE POLICY these cases pin, from the sources rather than from the actions:
//
//   * home_warranties, home_contractors, home_service_records: every command is
//     `is_family_member(family_id)` (0036_home_maintenance.sql:168-183, the last
//     policy statement on each table under supabase/migrations). The pages
//     (warranties, pros, service) render Add / Delete for every member with no
//     role check (components/home/*-client.tsx), and /dashboard/home is not
//     withheld from a guest (lib/auth/guest-scope.ts). So every role of the
//     household writes them, and no one writes another household's.
//   * A warranty is a "money paper": a non-manager reads only the ones they
//     added (lib/finance/household-money.ts:7-12, the held 0514). Whether a
//     non-manager may edit or bin one ANOTHER member added is not settled by an
//     applied policy (0514 is held), so it is not pinned here; each role's own
//     warranty, and a manager's edit of anyone's, are.
//   * logging a service visit moves the asset's last-serviced date for every
//     member (0336_only_a_manager_adds_edits_or_bins_an_asset.sql, title).
//   * scheduleRecommendedTasksAction writes a year of recurring tasks and is a
//     parent's or adult's: the action's own comment and the maintenance page,
//     which offers it only when `isManager(role)`
//     (app/(app)/dashboard/home/maintenance/page.tsx:39-40).
//
// The real exported actions run against tests/helpers/in-memory-supabase.ts;
// only the signed-in context, the translator (keys come back as themselves)
// and next/cache are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const {
  saveWarrantyAction, deleteWarrantyAction,
  saveContractorAction, deleteContractorAction,
  saveServiceRecordAction, deleteServiceRecordAction,
  scheduleRecommendedTasksAction,
} = await import('@/app/(app)/dashboard/home/actions');

const FAMILY_A = '00000000-0000-4000-8000-0000000000a1';
const FAMILY_B = '00000000-0000-4000-8000-0000000000b1';
const ASSET_A = '00000000-0000-4000-8000-00000000a5a1';
const ASSET_B = '00000000-0000-4000-8000-00000000a5b1';
const WARRANTY_A = '00000000-0000-4000-8000-00000000a7a1';
const WARRANTY_B = '00000000-0000-4000-8000-00000000a7b1';
const CONTRACTOR_A = '00000000-0000-4000-8000-00000000c0a1';
const CONTRACTOR_B = '00000000-0000-4000-8000-00000000c0b1';
const VISIT_A_OLD = '00000000-0000-4000-8000-00000000d0a0';
const VISIT_A = '00000000-0000-4000-8000-00000000d0a1';
const VISIT_B = '00000000-0000-4000-8000-00000000d0b1';
const PARENT_USER = '00000000-0000-4000-8000-0000000001a1';
const B_PARENT_USER = '00000000-0000-4000-8000-0000000001b1';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
type Caller = { label: string; role: Role; userId: string; email: string };

const CALLERS: Caller[] = [
  { label: 'parent', role: 'parent', userId: PARENT_USER, email: 'parent@example.com' },
  { label: 'adult', role: 'adult', userId: '00000000-0000-4000-8000-0000000002a1', email: 'adult@example.com' },
  { label: 'teen', role: 'teen', userId: '00000000-0000-4000-8000-0000000003a1', email: 'teen@example.com' },
  { label: 'child', role: 'child', userId: '00000000-0000-4000-8000-0000000004a1', email: 'child@example.com' },
  // A child who signs in with the kid PIN: the same role, a synthetic login.
  { label: 'child on a kid login', role: 'child', userId: '00000000-0000-4000-8000-0000000005a1', email: 'kid-0001@kids.example.com' },
  { label: 'caregiver', role: 'caregiver', userId: '00000000-0000-4000-8000-0000000006a1', email: 'caregiver@example.com' },
  { label: 'guest', role: 'guest', userId: '00000000-0000-4000-8000-0000000007a1', email: 'guest@example.com' },
];
const MANAGERS = CALLERS.filter((c) => c.role === 'parent' || c.role === 'adult');
const NON_MANAGERS = CALLERS.filter((c) => c.role !== 'parent' && c.role !== 'adult');
const PARENT = CALLERS[0];

let db: InMemorySupabase;

function signInAs(caller: Caller) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: caller.userId, email: caller.email },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      family: { id: FAMILY_A, timezone: 'America/New_York' },
      role: caller.role,
      member: { id: `member-${caller.userId}` },
    },
  });
}

function signedOut() {
  mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const TABLES = ['home_assets', 'home_warranties', 'home_contractors', 'home_service_records', 'maintenance_tasks'];
const rowsOf = (family: string) =>
  structuredClone(Object.fromEntries(TABLES.map((t) => [t, db.table(t).filter((r) => r.family_id === family)])));
const everything = () => structuredClone(Object.fromEntries(TABLES.map((t) => [t, db.table(t)])));
const one = (table: string, id: string): Row => {
  const row = db.table(table).find((r) => r.id === id);
  if (!row) throw new Error(`${table} ${id} is missing`);
  return row;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.createServer.mockResolvedValue(db);
  db.seed('home_assets', [
    { id: ASSET_A, family_id: FAMILY_A, name: 'Furnace', category: 'hvac', last_serviced_on: '2026-02-01' },
    { id: ASSET_B, family_id: FAMILY_B, name: 'Their furnace', category: 'hvac', last_serviced_on: '2026-02-01' },
  ]);
  db.seed('home_warranties', [
    { id: WARRANTY_A, family_id: FAMILY_A, name: 'Fridge cover', policy_number: 'PN-A', notes: 'kept in drawer', created_by: PARENT_USER, deleted_at: null },
    { id: WARRANTY_B, family_id: FAMILY_B, name: 'Their cover', policy_number: 'PN-B', notes: 'theirs', created_by: B_PARENT_USER, deleted_at: null },
  ]);
  db.seed('home_contractors', [
    { id: CONTRACTOR_A, family_id: FAMILY_A, name: 'Ace Plumbing', phone: '555-0100', email: 'ace@example.com', notes: 'good', deleted_at: null },
    { id: CONTRACTOR_B, family_id: FAMILY_B, name: 'Their plumber', phone: '555-0199', email: 'theirs@example.com', notes: 'b', deleted_at: null },
  ]);
  db.seed('home_service_records', [
    { id: VISIT_A_OLD, family_id: FAMILY_A, asset_id: ASSET_A, title: 'Old visit', service_date: '2025-08-01', provider: 'Ace', description: 'filter', deleted_at: null },
    { id: VISIT_A, family_id: FAMILY_A, asset_id: ASSET_A, title: 'Tune-up', service_date: '2026-02-01', provider: 'Ace', description: 'tune', deleted_at: null },
    { id: VISIT_B, family_id: FAMILY_B, asset_id: ASSET_B, title: 'Their visit', service_date: '2026-02-01', provider: 'Theirs', description: 'b', deleted_at: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());

// ── Warranties ──────────────────────────────────────────────────────────────
describe('saveWarrantyAction', () => {
  it.each(CALLERS)('ACTION-32EEEB118D20 a $label adds a warranty to their own household', async (caller) => {
    signInAs(caller);
    const before = rowsOf(FAMILY_B);
    await expect(saveWarrantyAction(form({ name: 'Dishwasher plan', asset_id: ASSET_A, policy_number: 'PN-NEW', expires_on: '2027-05-01' }))).resolves.toBeUndefined();
    const added = db.table('home_warranties').filter((r) => r.name === 'Dishwasher plan');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      family_id: FAMILY_A, asset_id: ASSET_A, policy_number: 'PN-NEW', expires_on: '2027-05-01',
      status: 'active', created_by: caller.userId, updated_by: caller.userId,
    });
    expect(rowsOf(FAMILY_B)).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/home/warranties');
  });

  it.each(CALLERS)('ACTION-32EEEB118D20 a $label edits a warranty they added', async (caller) => {
    signInAs(caller);
    const mine = '00000000-0000-4000-8000-00000000a7a9';
    db.seed('home_warranties', [{ id: mine, family_id: FAMILY_A, name: 'Mine', created_by: caller.userId, deleted_at: null }]);
    await saveWarrantyAction(form({ id: mine, name: 'Mine, renamed' }));
    expect(one('home_warranties', mine)).toMatchObject({ name: 'Mine, renamed', updated_by: caller.userId, family_id: FAMILY_A });
    expect(one('home_warranties', WARRANTY_A).name).toBe('Fridge cover');
  });

  it.each(MANAGERS)("ACTION-32EEEB118D20 a $label edits a warranty another member added", async (caller) => {
    signInAs(caller);
    await saveWarrantyAction(form({ id: WARRANTY_A, name: 'Fridge cover (extended)' }));
    expect(one('home_warranties', WARRANTY_A)).toMatchObject({ name: 'Fridge cover (extended)', updated_by: caller.userId });
  });

  it("ACTION-32EEEB118D20 another family's warranty id is refused and nothing in either household changes", async () => {
    signInAs(PARENT);
    const before = everything();
    await expect(saveWarrantyAction(form({ id: WARRANTY_B, name: 'Hijacked' }))).rejects.toThrow('actions.couldNotSaveThatWarranty');
    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-32EEEB118D20 another family's asset cannot be linked to a new warranty", async () => {
    signInAs(PARENT);
    const before = everything();
    await expect(saveWarrantyAction(form({ name: 'Linked elsewhere', asset_id: ASSET_B }))).rejects.toThrow('actions.assetNotFound');
    expect(everything()).toEqual(before);
  });

  it('ACTION-32EEEB118D20 a binned warranty is not edited back out of sight', async () => {
    signInAs(PARENT);
    db.replace('home_warranties', db.table('home_warranties').map((r) => (r.id === WARRANTY_A ? { ...r, deleted_at: '2026-01-01T00:00:00Z' } : r)));
    const before = everything();
    await expect(saveWarrantyAction(form({ id: WARRANTY_A, name: 'Revived' }))).rejects.toThrow('actions.couldNotSaveThatWarranty');
    expect(everything()).toEqual(before);
  });

  it('ACTION-32EEEB118D20 a signed-out caller is stopped before anything is written', async () => {
    signedOut();
    const before = everything();
    await expect(saveWarrantyAction(form({ name: 'Anon' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('deleteWarrantyAction', () => {
  it.each(CALLERS)('ACTION-D4AB4A7E1598 a $label bins a warranty they added, and its policy number goes with it', async (caller) => {
    signInAs(caller);
    const mine = '00000000-0000-4000-8000-00000000a7a9';
    db.seed('home_warranties', [{ id: mine, family_id: FAMILY_A, name: 'Mine', policy_number: 'PN-MINE', notes: 'n', created_by: caller.userId, deleted_at: null }]);
    await expect(deleteWarrantyAction(mine)).resolves.toBeUndefined();
    const binned = one('home_warranties', mine);
    expect(binned).toMatchObject({ policy_number: null, notes: null, updated_by: caller.userId });
    expect(typeof binned.deleted_at).toBe('string');
    expect(one('home_warranties', WARRANTY_A).deleted_at).toBeNull();
  });

  it.each(MANAGERS)('ACTION-D4AB4A7E1598 a $label bins a warranty another member added', async (caller) => {
    signInAs(caller);
    await deleteWarrantyAction(WARRANTY_A);
    expect(one('home_warranties', WARRANTY_A)).toMatchObject({ policy_number: null, notes: null, updated_by: caller.userId });
    expect(typeof one('home_warranties', WARRANTY_A).deleted_at).toBe('string');
  });

  it.each(CALLERS)("ACTION-D4AB4A7E1598 a $label cannot bin another family's warranty", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(deleteWarrantyAction(WARRANTY_B)).rejects.toThrow('actions.couldNotDeleteThatWarranty');
    expect(everything()).toEqual(before);
    expect(one('home_warranties', WARRANTY_B).policy_number).toBe('PN-B');
  });

  it('ACTION-D4AB4A7E1598 a signed-out caller bins nothing', async () => {
    signedOut();
    const before = everything();
    await expect(deleteWarrantyAction(WARRANTY_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

// ── Contractors ─────────────────────────────────────────────────────────────
describe('saveContractorAction', () => {
  it.each(CALLERS)('ACTION-5C383A793E23 a $label adds a contractor to their own household', async (caller) => {
    signInAs(caller);
    const before = rowsOf(FAMILY_B);
    await expect(saveContractorAction(form({ name: 'Bright Electric', trade: 'electric', phone: '555-0111', rating: '4', is_preferred: 'on' }))).resolves.toBeUndefined();
    const added = db.table('home_contractors').filter((r) => r.name === 'Bright Electric');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      family_id: FAMILY_A, trade: 'electric', phone: '555-0111', rating: 4, is_preferred: true,
      created_by: caller.userId, updated_by: caller.userId,
    });
    expect(rowsOf(FAMILY_B)).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/home/pros');
  });

  it.each(CALLERS)("ACTION-5C383A793E23 a $label edits the household's contractor", async (caller) => {
    signInAs(caller);
    await saveContractorAction(form({ id: CONTRACTOR_A, name: 'Ace Plumbing & Heating', phone: '555-0101' }));
    expect(one('home_contractors', CONTRACTOR_A)).toMatchObject({ name: 'Ace Plumbing & Heating', phone: '555-0101', updated_by: caller.userId, family_id: FAMILY_A });
  });

  it.each(CALLERS)("ACTION-5C383A793E23 a $label cannot edit another family's contractor", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(saveContractorAction(form({ id: CONTRACTOR_B, name: 'Hijacked' }))).rejects.toThrow('actions.couldNotSaveThatContractor');
    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-5C383A793E23 a signed-out caller adds nothing', async () => {
    signedOut();
    const before = everything();
    await expect(saveContractorAction(form({ name: 'Anon' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('deleteContractorAction', () => {
  it.each(CALLERS)("ACTION-511E8EAE5D3F a $label bins the household's contractor, and their phone and email go with it", async (caller) => {
    signInAs(caller);
    await expect(deleteContractorAction(CONTRACTOR_A)).resolves.toBeUndefined();
    const binned = one('home_contractors', CONTRACTOR_A);
    expect(binned).toMatchObject({ phone: null, email: null, notes: null, updated_by: caller.userId });
    expect(typeof binned.deleted_at).toBe('string');
  });

  it.each(CALLERS)("ACTION-511E8EAE5D3F a $label cannot bin another family's contractor", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(deleteContractorAction(CONTRACTOR_B)).rejects.toThrow('actions.couldNotDeleteThatContractor');
    expect(everything()).toEqual(before);
    expect(one('home_contractors', CONTRACTOR_B)).toMatchObject({ phone: '555-0199', email: 'theirs@example.com', deleted_at: null });
  });

  it('ACTION-511E8EAE5D3F a signed-out caller bins nothing', async () => {
    signedOut();
    const before = everything();
    await expect(deleteContractorAction(CONTRACTOR_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

// ── Service records ─────────────────────────────────────────────────────────
describe('saveServiceRecordAction', () => {
  it.each(CALLERS)('ACTION-006967105DCD a $label logs a service visit, and the asset is marked serviced that day', async (caller) => {
    signInAs(caller);
    const before = rowsOf(FAMILY_B);
    await expect(saveServiceRecordAction(form({ asset_id: ASSET_A, title: 'Filter swap', service_date: '2026-03-15', provider: 'Ace', cost: '80' }))).resolves.toBeUndefined();
    const logged = db.table('home_service_records').filter((r) => r.title === 'Filter swap');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ family_id: FAMILY_A, asset_id: ASSET_A, service_date: '2026-03-15', cost: 80, created_by: caller.userId });
    expect(one('home_assets', ASSET_A).last_serviced_on).toBe('2026-03-15');
    expect(rowsOf(FAMILY_B)).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/home/service');
  });

  it.each(CALLERS)("ACTION-006967105DCD a $label cannot log a visit against another family's asset", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(saveServiceRecordAction(form({ asset_id: ASSET_B, title: 'Planted', service_date: '2026-04-01' }))).rejects.toThrow('actions.assetNotFound');
    expect(everything()).toEqual(before);
    expect(one('home_assets', ASSET_B).last_serviced_on).toBe('2026-02-01');
  });

  it('ACTION-006967105DCD a signed-out caller logs nothing', async () => {
    signedOut();
    const before = everything();
    await expect(saveServiceRecordAction(form({ asset_id: ASSET_A, title: 'Anon' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('deleteServiceRecordAction', () => {
  it.each(CALLERS)('ACTION-519195A63714 a $label bins a visit, and the asset falls back to the visit before it', async (caller) => {
    signInAs(caller);
    await expect(deleteServiceRecordAction(VISIT_A)).resolves.toBeUndefined();
    const binned = one('home_service_records', VISIT_A);
    expect(binned).toMatchObject({ provider: null, description: null, updated_by: caller.userId });
    expect(typeof binned.deleted_at).toBe('string');
    expect(one('home_assets', ASSET_A).last_serviced_on).toBe('2025-08-01');
    expect(one('home_service_records', VISIT_A_OLD).deleted_at).toBeNull();
  });

  it.each(CALLERS)("ACTION-519195A63714 a $label cannot bin another family's visit", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(deleteServiceRecordAction(VISIT_B)).rejects.toThrow('actions.couldNotDeleteThatService');
    expect(everything()).toEqual(before);
  });

  it('ACTION-519195A63714 a signed-out caller bins nothing', async () => {
    signedOut();
    const before = everything();
    await expect(deleteServiceRecordAction(VISIT_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

// ── Recommended maintenance ─────────────────────────────────────────────────
describe('scheduleRecommendedTasksAction', () => {
  it.each(MANAGERS)("ACTION-DD076FC781C8 a $label schedules the asset's recommended tasks from its last service", async (caller) => {
    signInAs(caller);
    await expect(scheduleRecommendedTasksAction(ASSET_A)).resolves.toEqual({ ok: true, created: 2 });
    const tasks = db.table('maintenance_tasks');
    expect(tasks.map((t) => [t.title, t.interval_days, t.due_at]).sort()).toEqual([
      ['Professional HVAC service / tune-up', 365, '2027-02-01T12:00:00.000Z'],
      ['Replace air filter', 90, '2026-05-02T12:00:00.000Z'],
    ]);
    expect(tasks.map((t) => [t.family_id, t.asset_id, t.created_by])).toEqual([
      [FAMILY_A, ASSET_A, caller.userId],
      [FAMILY_A, ASSET_A, caller.userId],
    ]);
    // A second press adds nothing.
    await expect(scheduleRecommendedTasksAction(ASSET_A)).resolves.toEqual({ ok: true, created: 0 });
    expect(db.table('maintenance_tasks')).toHaveLength(2);
  });

  it.each(NON_MANAGERS)('ACTION-DD076FC781C8 a $label is told a parent or adult schedules maintenance, and nothing is written', async (caller) => {
    signInAs(caller);
    await expect(scheduleRecommendedTasksAction(ASSET_A)).resolves.toEqual({
      ok: false, created: 0, error: 'actions.onlyAParentOrAdultCanScheduleMaintenance',
    });
    expect(db.table('maintenance_tasks')).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(MANAGERS)("ACTION-DD076FC781C8 a $label cannot schedule tasks on another family's asset", async (caller) => {
    signInAs(caller);
    const before = everything();
    await expect(scheduleRecommendedTasksAction(ASSET_B)).resolves.toEqual({ ok: false, created: 0, error: 'actions.assetNotFound' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-DD076FC781C8 a signed-out caller schedules nothing', async () => {
    signedOut();
    await expect(scheduleRecommendedTasksAction(ASSET_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('maintenance_tasks')).toEqual([]);
  });
});
