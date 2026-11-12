// Callers for the site-admin console's server actions, against real tables.
//
// WHY THIS EXISTS: tests/every-admin-action-refuses-before-it-touches-data.test.ts
// proves each admin action refuses an outsider before it touches anything, with
// a recorder for a database. It cannot say what an ALLOWED call writes, or that
// a refused call left two real households exactly as they were. This helper
// pairs the in-memory PostgREST fake (tests/helpers/in-memory-supabase.ts) with
// the identity half of the cookie client, so the real gates run —
// lib/supabase/auth's getUser and isSuperAdmin, lib/auth/super-admin-assurance,
// superAdminGate and requireMarketingAdmin — and the real action writes to the
// same tables a test then reads back.
//
// Two households are seeded, A and B, each with one member of every family
// role and a profile per member. Every member is an ordinary account: no
// family role, a household's "Parent / Admin" included, is a platform admin.
// The super admin is matched the way production matches one, by email against
// the `super_admins` table that `is_super_admin()` (0008) reads.
//
// A test file wires it in with two mocks:
//   vi.mock('@/lib/supabase/server', async (importOriginal) =>
//     (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
// and signs a caller in with `signInAs(...)` before each call.
import type { MemberRole } from '@/lib/constants/roles';
import { createInMemorySupabase, type InMemoryOptions, type InMemorySupabase, type Row } from './in-memory-supabase';

export const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
export const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';

export const FAMILY_ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const satisfies readonly MemberRole[];
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export type Caller =
  | { kind: 'super_admin' }
  /** A super admin whose password-only session still owes an enrolled authenticator's code. */
  | { kind: 'admin_owes_code' }
  | { kind: 'signed_out' }
  | { kind: 'member'; role: FamilyRole; family?: 'A' | 'B' };

export const SUPER_ADMIN = { id: '5a000000-0000-4000-8000-000000000001', email: 'site.admin@example.com' } as const;

const ROLE_DIGIT: Record<FamilyRole, number> = { parent: 1, adult: 2, teen: 3, child: 4, caregiver: 5, guest: 6 };

/** The fixed user id of a member of household A or B. */
export function userIdOf(role: FamilyRole, family: 'A' | 'B' = 'A'): string {
  return `${family === 'A' ? 'a' : 'b'}1000000-0000-4000-8000-00000000000${ROLE_DIGIT[role]}`;
}
/** The fixed family_members.id of a member of household A or B. */
export function memberIdOf(role: FamilyRole, family: 'A' | 'B' = 'A'): string {
  return `${family === 'A' ? 'a' : 'b'}2000000-0000-4000-8000-00000000000${ROLE_DIGIT[role]}`;
}
export function emailOf(role: FamilyRole, family: 'A' | 'B' = 'A'): string {
  return `${role}.${family.toLowerCase()}@example.com`;
}

/** Every caller the admin console must refuse, with a label for `it.each`. */
export const REFUSED_CALLERS: { label: string; caller: Caller; status: 401 | 403 }[] = [
  ...FAMILY_ROLES.map((role) => ({ label: `a household ${role} (not a site admin)`, caller: { kind: 'member', role } as Caller, status: 403 as const })),
  { label: 'a super admin who still owes their two-step code', caller: { kind: 'admin_owes_code' }, status: 403 },
  { label: 'a signed-out caller', caller: { kind: 'signed_out' }, status: 401 },
];

const state = {
  db: null as InMemorySupabase | null,
  caller: { kind: 'signed_out' } as Caller,
};

function currentDb(): InMemorySupabase {
  if (!state.db) throw new Error('[admin-callers] call newAdminWorld() in beforeEach');
  return state.db;
}

function identity(): { id: string; email: string } | null {
  const caller = state.caller;
  if (caller.kind === 'signed_out') return null;
  if (caller.kind === 'super_admin' || caller.kind === 'admin_owes_code') return { ...SUPER_ADMIN };
  return { id: userIdOf(caller.role, caller.family), email: emailOf(caller.role, caller.family) };
}

/**
 * The cookie-bound client: who is calling, and nothing else. Any table read
 * through it throws, so an action that reads the caller's own client instead
 * of the service client is seen, not silently served.
 */
function cookieClient() {
  const user = identity();
  const owesCode = state.caller.kind === 'admin_owes_code';
  return {
    auth: {
      getUser: async () => ({ data: { user: user ? { ...user, aud: 'authenticated', app_metadata: {}, user_metadata: {} } : null }, error: null }),
      getSession: async () => ({ data: { session: user ? { access_token: 'fixture-token', user } : null }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: owesCode ? 'aal2' : 'aal1', currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    // 0008's is_super_admin(): the caller's email is on the super_admins table.
    rpc: async (name: string) => {
      if (name !== 'is_super_admin') throw new Error(`[admin-callers] unexpected cookie rpc ${name}`);
      const email = user?.email.toLowerCase() ?? '';
      return { data: currentDb().table('super_admins').some((row) => row.email === email), error: null };
    },
    from: (table: string) => { throw new Error(`[admin-callers] unexpected cookie-client read of ${table}`); },
  };
}

/** The `@/lib/supabase/server` module, with both clients answered from the fixture. */
export function supabaseServerModule(original: Record<string, unknown>): Record<string, unknown> {
  return {
    ...original,
    createServer: async () => cookieClient(),
    createServiceClient: () => currentDb(),
  };
}

/** A storage bucket fake on the service client: objects live in `storage.objects`. */
function attachStorage(db: InMemorySupabase): void {
  (db as unknown as { storage: unknown }).storage = {
    from: (bucket: string) => ({
      upload: async (path: string, file: { size?: number }, opts?: { contentType?: string }) => {
        const objects = db.table('storage.objects');
        if (objects.some((o) => o.bucket_id === bucket && o.name === path)) {
          return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
        }
        objects.push({ bucket_id: bucket, name: path, size: file?.size ?? null, content_type: opts?.contentType ?? null });
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        const objects = db.table('storage.objects');
        const gone = objects.filter((o) => o.bucket_id === bucket && paths.includes(String(o.name)));
        db.replace('storage.objects', objects.filter((o) => !gone.includes(o)));
        return { data: gone.map((o) => ({ name: o.name })), error: null };
      },
    }),
  };
}

/**
 * Tables whose primary key is not `id`. PostgREST resolves an upsert that names
 * no conflict target on the primary key; the fake assumes `id`, so without this
 * an upsert of `{ key: 'x' }` would add a second row where Postgres updates one.
 */
const PRIMARY_KEYS: Record<string, string> = {
  marketing_settings: 'key', // 0013
  app_settings: 'key', // 0023
};

function upsertOnPrimaryKey(db: InMemorySupabase): void {
  const from = db.from.bind(db);
  db.from = (table: string) => {
    const builder = from(table);
    const pk = PRIMARY_KEYS[table];
    if (pk) {
      const upsert = builder.upsert.bind(builder);
      builder.upsert = (rows, opts) => upsert(rows, { ...opts, onConflict: opts?.onConflict ?? pk });
    }
    return builder;
  };
}

/**
 * A fresh world: households A and B with every family role, their profiles,
 * and one site admin on the allowlist. Returns the service-role database.
 */
export function newAdminWorld(options: InMemoryOptions = {}): InMemorySupabase {
  const db = createInMemorySupabase(options);
  attachStorage(db);
  upsertOnPrimaryKey(db);
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A' },
    { id: FAMILY_B, name: 'Household B' },
  ]);
  for (const family of ['A', 'B'] as const) {
    for (const role of FAMILY_ROLES) {
      db.seed('family_members', [{
        id: memberIdOf(role, family), family_id: family === 'A' ? FAMILY_A : FAMILY_B,
        user_id: userIdOf(role, family), role, display_name: `${role} ${family}`, is_active: true,
      }]);
      db.seed('profiles', [{ id: userIdOf(role, family), email: emailOf(role, family), full_name: `${role} ${family}` }]);
    }
  }
  db.seed('super_admins', [{ email: SUPER_ADMIN.email }]);
  state.db = db;
  state.caller = { kind: 'signed_out' };
  return db;
}

export function signInAs(caller: Caller): void {
  state.caller = caller;
}

/** Every table, deep-copied: a refused call must leave this exactly as it was. */
export function snapshot(db: InMemorySupabase): Record<string, Row[]> {
  const tables = (db as unknown as { tables: Map<string, Row[]> }).tables;
  const out: Record<string, Row[]> = {};
  for (const [name, rows] of tables) if (rows.length) out[name] = structuredClone(rows);
  return out;
}
