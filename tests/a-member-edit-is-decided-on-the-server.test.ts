// A7 + A12 — the roster editors wrote member rows straight from the browser.
//
// A7: Settings' member editor offered every role, so a parent could make a
// member who signs in with a 4-digit kid PIN a parent or adult (the family
// editor refused it; the held 0512 is the database rule). resetChildPinAction
// then refused to reset that PIN, because the member was a manager.
//
// A12: both editors wrote `{display_name, role, ...}` from a roster copy loaded
// once, with no `is_active` or version check. A second manager's stale tab
// wrote a removed member's old role back over REMOVED_MEMBER_PATCH — so the
// next accepted invite brought them back as a caregiver, adult or parent — and
// put back whatever another manager had changed meanwhile.
//
// Both editors now go through updateFamilyMemberAction. Driven through it
// against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-mum' }, memberships: [],
    active: { familyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: state.role, member: { id: 'mum' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { updateFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
let db: InMemorySupabase;
const row = (id: string) => db.table('family_members').find((m) => m.id === id)!;
const stamp = (id: string) => row(id).updated_at as string;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.role = 'parent';
  db = createInMemorySupabase();
  Object.assign(db.auth, {
    admin: { getUserById: async (id: string) => ({ data: { user: { id, email: id === 'u-sam' ? 'child.sam@kids.bubaly.app' : `${id}@example.test`, user_metadata: {} } }, error: null }) },
  });
  state.db = db;
  db.seed('family_members', [
    { id: 'mum', family_id: FAMILY, user_id: 'u-mum', role: 'parent', is_active: true, display_name: 'Mum', birthday: null, email: null, phone: null, updated_at: '2026-10-01T00:00:00.000Z' },
    { id: 'ella', family_id: FAMILY, user_id: 'u-ella', role: 'child', is_active: true, display_name: 'Ella', birthday: '2016-05-01', email: null, phone: null, updated_at: '2026-10-01T00:00:00.000Z' },
    // A teen whose login is a kid PIN, with no child_logins row left: the account says what it is.
    { id: 'sam', family_id: FAMILY, user_id: 'u-sam', role: 'teen', is_active: true, display_name: 'Sam', birthday: null, email: null, phone: null, updated_at: '2026-10-01T00:00:00.000Z' },
    { id: 'nan', family_id: FAMILY, user_id: 'u-nan', role: 'caregiver', is_active: true, display_name: 'Nan', birthday: null, email: null, phone: '555', updated_at: '2026-10-01T00:00:00.000Z' },
  ]);
  db.seed('child_logins', [{ id: 'cl-ella', family_id: FAMILY, member_id: 'ella', user_id: 'u-ella', username: 'ella' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('a kid login is never made a parent or adult (A7)', () => {
  it.each(['parent', 'adult'] as const)('refuses %s for a member with a child_logins row, and writes nothing', async (role) => {
    const result = await updateFamilyMemberAction({ memberId: 'ella', expectedUpdatedAt: stamp('ella'), changes: { display_name: 'Ella', role } });
    expect(result).toEqual({ ok: false, error: 'familyModule.aKidLoginCannotBeAManager' });
    expect(row('ella').role).toBe('child');
  });

  it('refuses it for an account that is itself a kid login, child_logins row or not', async () => {
    const result = await updateFamilyMemberAction({ memberId: 'sam', expectedUpdatedAt: stamp('sam'), changes: { role: 'adult' } });
    expect(result.ok).toBe(false);
    expect(row('sam').role).toBe('teen');
  });

  it('still lets a parent make an ordinary account an adult, and records it in the trust ledger (control)', async () => {
    const result = await updateFamilyMemberAction({ memberId: 'nan', expectedUpdatedAt: stamp('nan'), changes: { role: 'adult' } });
    expect(result).toEqual({ ok: true });
    expect(row('nan').role).toBe('adult');
    expect(db.table('trust_audit_logs')).toEqual([expect.objectContaining({
      family_id: FAMILY, decision: 'role_changed', actor_id: 'mum', context: { memberId: 'nan', from: 'caregiver', to: 'adult' },
    })]);
  });

  it('a kid login\'s other details still save', async () => {
    expect(await updateFamilyMemberAction({ memberId: 'ella', expectedUpdatedAt: stamp('ella'), changes: { display_name: 'Ella R', role: 'child' } })).toEqual({ ok: true });
    expect(row('ella')).toMatchObject({ display_name: 'Ella R', role: 'child' });
  });

  it('an adult cannot grant parent', async () => {
    state.role = 'adult';
    expect((await updateFamilyMemberAction({ memberId: 'nan', expectedUpdatedAt: stamp('nan'), changes: { role: 'parent' } })).ok).toBe(false);
    expect(row('nan').role).toBe('caregiver');
  });
});

describe('a stale editor cannot undo a removal or another manager\'s edit (A12)', () => {
  it('refuses to edit a member another manager removed, so the removal\'s guest role stands', async () => {
    const opened = stamp('nan');
    // Parent B removes Nan while parent A's tab still lists her.
    Object.assign(row('nan'), { is_active: false, role: 'guest', updated_at: '2026-10-02T00:00:00.000Z' });
    const result = await updateFamilyMemberAction({ memberId: 'nan', expectedUpdatedAt: opened, changes: { display_name: 'Nan', role: 'caregiver', phone: '556' } });
    expect(result).toEqual({ ok: false, error: 'familyModule.thatMemberWasRemoved' });
    expect(row('nan')).toMatchObject({ is_active: false, role: 'guest', phone: '555' });
  });

  it('refuses an edit opened before someone else changed the row', async () => {
    const opened = stamp('nan');
    Object.assign(row('nan'), { phone: '999', updated_at: '2026-10-02T00:00:00.000Z' });
    const result = await updateFamilyMemberAction({ memberId: 'nan', expectedUpdatedAt: opened, changes: { display_name: 'Nan', role: 'caregiver', phone: '555' } });
    expect(result).toEqual({ ok: false, error: 'familyModule.thatMemberChangedMeanwhile' });
    expect(row('nan').phone).toBe('999');
  });

  it('writes only the columns that changed', async () => {
    const patches: Record<string, unknown>[] = [];
    const from = db.from.bind(db);
    state.db = new Proxy(db, { get: (target, key) => (key !== 'from' ? Reflect.get(target, key) : (table: string) => {
      const builder = from(table);
      if (table !== 'family_members') return builder;
      const update = builder.update.bind(builder);
      return Object.assign(builder, { update: (patch: Record<string, unknown>) => { patches.push(patch); return update(patch); } });
    }) });
    expect(await updateFamilyMemberAction({ memberId: 'nan', expectedUpdatedAt: stamp('nan'), changes: { display_name: 'Nan', role: 'caregiver', birthday: null, email: null, phone: '556' } })).toEqual({ ok: true });
    // The role, name and empty fields a stale copy carried are not re-sent.
    expect(patches).toEqual([{ phone: '556' }]);
    expect(row('nan')).toMatchObject({ phone: '556', role: 'caregiver', display_name: 'Nan' });
    expect(db.table('trust_audit_logs')).toEqual([]);
  });

  it('a child cannot edit anyone', async () => {
    state.role = 'child';
    expect((await updateFamilyMemberAction({ memberId: 'nan', changes: { display_name: 'X' } })).ok).toBe(false);
    expect(row('nan').display_name).toBe('Nan');
  });
});
