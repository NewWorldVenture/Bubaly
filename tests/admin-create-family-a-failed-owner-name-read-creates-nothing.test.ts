import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// adminCreateFamilyAction read the owner's profile for the display name and
// dropped the read's error. A failed read left full_name null, so the family
// was created and its parent seat saved with the address's local part ("nan")
// as display_name, reported as a success (review
// R10-CREATE-FAMILY-OWNER-NAME-READ-DROPPED). Nothing is created now until the
// read answers. The REAL action over the in-memory database; only the auth
// guard and the request translator are stand-ins.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { adminCreateFamilyAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
let faulted = 0;
const input = { name: 'The Okafors', timezone: 'UTC', ownerEmail: 'nan@example.test' };
/** The tables a created family writes. */
const WRITTEN = ['families', 'family_members', 'subscriptions', 'audit_logs'];

function seed() {
  db.seed('auth_users', [{ id: 'u-nan', email: 'nan@example.test', user_metadata: {} }]);
  Object.assign(db.auth, {
    admin: {
      listUsers: async ({ page = 1 }: { page?: number } = {}) => ({ data: { users: page === 1 ? db.table('auth_users') : [] }, error: null }),
    },
  });
  db.seed('profiles', [{ id: 'u-nan', full_name: 'Nan Okafor', email: 'nan@example.test' }]);
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  faulted = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a family the admin console creates seats its owner by the name it read', () => {
  it('an owner profile read that FAILS creates nothing and is not a success', async () => {
    seed();
    // Only the profile read fails; it is counted, so a fault that never fires cannot pass.
    h.db = withFaults(db, (table) => {
      if (table !== 'profiles') return null;
      faulted += 1;
      return { message: 'profiles unavailable' };
    });
    const result = await adminCreateFamilyAction(input);
    expect(faulted).toBe(1);
    expect(result).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.couldNotCheckThatRefresh'] });
    for (const table of WRITTEN) expect(db.table(table)).toEqual([]);
    // Not written and rolled back: never touched.
    expect(db.log.filter((entry) => WRITTEN.includes(entry.table))).toEqual([]);
  });

  it('the control: the read answers, and the parent seat carries the profile\'s full_name', async () => {
    seed();
    const result = await adminCreateFamilyAction(input);
    expect(result).toEqual({ ok: true });
    expect(db.table('families')).toEqual([expect.objectContaining({ name: 'The Okafors', created_by: 'u-nan' })]);
    expect(db.table('family_members')).toEqual([
      expect.objectContaining({ family_id: db.table('families')[0].id, user_id: 'u-nan', role: 'parent', display_name: 'Nan Okafor' }),
    ]);
  });

  it('the control: an owner with no profile, from a read that answered, is seated by the address', async () => {
    seed();
    db.replace('profiles', []);
    expect(await adminCreateFamilyAction(input)).toEqual({ ok: true });
    expect(db.table('family_members')).toEqual([expect.objectContaining({ user_id: 'u-nan', display_name: 'nan' })]);
  });
});
