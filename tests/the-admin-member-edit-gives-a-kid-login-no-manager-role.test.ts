// A7 (the admin console) — the super-admin member edit could still make a kid
// login a parent or an adult, and recorded nothing in the trust ledger.
//
// Both household editors go through updateFamilyMemberAction, which refuses a
// manager role for a member who signs in with a kid PIN (a child_logins row,
// or an account that is itself a kid login) and writes role_changed to the
// ledger. adminUpdateMemberAction wrote { display_name, role } with the service
// role and asked neither, so it was the one path left to a manager account
// behind a 4-digit PIN. It now asks the same question through the same helper
// (memberHasAKidLogin), and records a role change it makes.
//
// Driven through the real action against the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => true, getUser: async () => ({ id: 'super-admin' }) }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { adminUpdateMemberAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
const row = (id: string) => db.table('family_members').find((m) => m.id === id)!;
const ledger = () => db.table('trust_audit_logs');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('auth_users', [
    { id: 'u-ella', email: 'child.ella@kids.bubaly.app', user_metadata: {} },
    // A kid login whose child_logins row is gone: its address still says so.
    { id: 'u-leo', email: 'child.leo@kids.bubaly.app', user_metadata: {} },
    { id: 'u-nan', email: 'nan@example.test', user_metadata: {} },
  ]);
  Object.assign(db.auth, {
    admin: { getUserById: async (id: string) => ({ data: { user: db.table('auth_users').find((u) => u.id === id) ?? null }, error: null }) },
  });
  db.seed('family_members', [
    { id: 'ella', family_id: FAMILY, user_id: 'u-ella', role: 'child', is_active: true, display_name: 'Ella' },
    { id: 'leo', family_id: FAMILY, user_id: 'u-leo', role: 'teen', is_active: true, display_name: 'Leo' },
    { id: 'nan', family_id: FAMILY, user_id: 'u-nan', role: 'caregiver', is_active: true, display_name: 'Nan' },
  ]);
  db.seed('child_logins', [{ id: 'cl-ella', family_id: FAMILY, member_id: 'ella', user_id: 'u-ella', username: 'ella' }]);
  state.db = db;
});

describe('the admin console\'s member edit', () => {
  it.each(['parent', 'adult'] as const)('does not make a kid login a %s', async (role) => {
    expect(await adminUpdateMemberAction('ella', { displayName: 'Ella', role })).toEqual({ ok: false, error: 'familyModule.aKidLoginCannotBeAManager' });
    expect(row('ella')).toMatchObject({ role: 'child', display_name: 'Ella' });
    expect(ledger()).toEqual([]);
  });

  it('knows a kid login by its account when its child_logins row is gone', async () => {
    expect(await adminUpdateMemberAction('leo', { displayName: 'Leo', role: 'adult' })).toMatchObject({ ok: false });
    expect(row('leo')).toMatchObject({ role: 'teen' });
  });

  it('refuses when it cannot tell whether the member is a kid login', async () => {
    state.db = withFaults(db, (table) => (table === 'child_logins' ? { message: 'fixture read refused' } : null));
    expect(await adminUpdateMemberAction('nan', { displayName: 'Nan', role: 'adult' })).toMatchObject({ ok: false });
    expect(row('nan')).toMatchObject({ role: 'caregiver' });
  });

  it('still renames a kid login and changes it to another child role', async () => {
    expect(await adminUpdateMemberAction('ella', { displayName: 'Ella B', role: 'teen' })).toEqual({ ok: true });
    expect(row('ella')).toMatchObject({ role: 'teen', display_name: 'Ella B' });
  });

  it('makes an ordinary account an adult, and records the role change in the family\'s trust ledger', async () => {
    expect(await adminUpdateMemberAction('nan', { displayName: 'Nan', role: 'adult' })).toEqual({ ok: true });
    expect(row('nan')).toMatchObject({ role: 'adult' });
    expect(ledger()).toEqual([expect.objectContaining({
      family_id: FAMILY, actor_id: null, decision: 'role_changed',
      context: { memberId: 'nan', from: 'caregiver', to: 'adult', by: 'super_admin' },
    })]);
  });

  it('records nothing in the ledger when only the name changed (control)', async () => {
    expect(await adminUpdateMemberAction('nan', { displayName: 'Nana', role: 'caregiver' })).toEqual({ ok: true });
    expect(row('nan')).toMatchObject({ display_name: 'Nana', role: 'caregiver' });
    expect(ledger()).toEqual([]);
  });
});
