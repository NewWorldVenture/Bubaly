import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isChildLoginEmail, syntheticChildEmail } from '@/lib/onboarding/child-login';

/**
 * A child removed from the family does not become the parent of a new one.
 *
 * Removing a member (the family module, Settings, the admin console) sets
 * `family_members.is_active = false` and nothing else. A child's username/PIN
 * login — its `child_logins` row and its synthetic auth user — survives that.
 *
 * Two things then went wrong together:
 *
 *  - `childSignInAction` never asked whether the child was still in a family,
 *    so the PIN kept signing in after the parent had removed them.
 *  - Once signed in (or simply on the next page load of a tablet that already
 *    was), `getUserContext` correctly found no active membership, and
 *    `requireUserContext` "rescued" the account the way it rescues a fresh
 *    signup: `ensureActiveFamily` provisioned a brand-new family with the child
 *    account as its `parent`, plus a trial. The child landed on a parent
 *    dashboard with none of a child's limits, and the PIN the parent thought
 *    they had retired was now the key to a manager account.
 *
 * The fake below is one in-memory database shared by the service client and
 * the caller's client. Its `ensure_family_for_user` RPC does what the real one
 * does (0212): creates the family and makes the caller its active `parent`.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failReads: new Set<string>(),
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  signIns: [] as Array<{ email: string }>,
  user: null as null | { id: string; email: string | null; user_metadata: Record<string, unknown> },
}));

class RedirectSignal extends Error {
  constructor(readonly path: string) { super(`redirect ${path}`); }
}

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let limit: number | null = null;
  const read = () => {
    if (db.failReads.has(table)) return { data: null, error: { message: `synthetic ${table} read failure` } };
    const rows = (db.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
    return { data: limit === null ? rows : rows.slice(0, limit), error: null };
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return chain; },
    in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return chain; },
    limit: (n: number) => { limit = n; return chain; },
    maybeSingle: async () => {
      const result = read();
      return result.error ? result : { data: result.data?.[0] ?? null, error: null };
    },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(read()).then(resolve, reject),
    upsert: async (row: Row) => { (db.tables[table] ??= []).push(row); return { error: null }; },
    insert: async (row: Row) => { (db.tables[table] ??= []).push(row); return { error: null }; },
  };
  return chain;
}

const client = {
  from: (table: string) => query(table),
  rpc: async (name: string, args: Record<string, unknown>) => {
    db.rpc.push({ name, args });
    if (name !== 'ensure_family_for_user') return { data: null, error: { message: 'unknown rpc' } };
    const familyId = 'fam-provisioned';
    (db.tables.families ??= []).push({ id: familyId, name: args.p_name, created_by: args.p_user_id });
    (db.tables.family_members ??= []).push({
      id: 'member-provisioned', family_id: familyId, user_id: args.p_user_id, role: 'parent',
      display_name: args.p_display_name, is_active: true, created_at: '2026-10-09T00:00:00Z',
    });
    return { data: familyId, error: null };
  },
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
};

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => client,
  createServiceClient: () => client,
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new RedirectSignal(path); },
  notFound: () => { throw new RedirectSignal('404'); },
}));
vi.mock('next/headers', () => ({
  cookies: async () => { throw new Error('cookies must not be touched'); },
  headers: async () => new Headers({ 'x-forwarded-for': '192.0.2.10' }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 0 }));
vi.mock('@/lib/server/feature-entitlement', () => ({ resolveFeatureEntitlement: async () => ({ allowed: true }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/auth/child-throttle-store', () => ({ reserveChildLoginAttempt: async () => ({ ok: true }) }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => ({
      auth: {
        signInWithPassword: async ({ email }: { email: string }) => {
          db.signIns.push({ email });
          const token = [
            Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
            Buffer.from(JSON.stringify({ sub: CHILD })).toString('base64url'),
            'sig',
          ].join('.');
          const user = { id: CHILD, email };
          return { data: { user, session: { access_token: token, refresh_token: 'synthetic-refresh', user } }, error: null };
        },
        dispose: async () => {},
      },
    }),
  };
});

const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const { ensureActiveFamily } = await import('@/lib/server/ensure-family');
const { requireUserContext } = await import('@/lib/supabase/auth');
const { childSignInAction } = await import('@/app/(auth)/actions');

function seed(opts: { childActive: boolean }) {
  db.tables = {
    families: [{ id: FAMILY, name: 'The Okafors', created_by: ADULT }],
    family_members: [
      { id: 'member-parent', family_id: FAMILY, user_id: ADULT, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'member-emma', family_id: FAMILY, user_id: CHILD, role: 'child', is_active: opts.childActive, created_at: '2026-01-02T00:00:00Z' },
    ],
    child_logins: [{ id: 'login-emma', family_id: FAMILY, member_id: 'member-emma', user_id: CHILD, username: 'emma' }],
  };
}

const childUser = () => ({ id: CHILD, email: syntheticChildEmail('emma'), user_metadata: { child: true } });
const parentRowsFor = (userId: string) =>
  (db.tables.family_members ?? []).filter((row) => row.user_id === userId && row.role === 'parent' && row.is_active);

beforeEach(() => {
  db.failReads = new Set();
  db.rpc = [];
  db.signIns = [];
  db.user = null;
  vi.stubEnv('CHILD_LOGIN_SECRET', 'synthetic-child-secret');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://removed-child.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('telling a child login by its address', () => {
  it('matches the synthetic kids domain in any case, and nothing else', () => {
    expect(isChildLoginEmail(syntheticChildEmail('emma'))).toBe(true);
    expect(isChildLoginEmail(' Child.Emma@Kids.Bubaly.App ')).toBe(true);
    expect(isChildLoginEmail('emma@example.com')).toBe(false);
    expect(isChildLoginEmail('child.emma@kids.bubaly.app.example.com')).toBe(false);
    expect(isChildLoginEmail(null)).toBe(false);
    expect(isChildLoginEmail(undefined)).toBe(false);
  });
});

describe('a child account is never provisioned a family of its own', () => {
  it('does not make a removed child the parent of a new family', async () => {
    seed({ childActive: false });
    expect(await ensureActiveFamily(client as never, childUser())).toBe(false);
    expect(db.rpc).toEqual([]);
    expect(parentRowsFor(CHILD)).toEqual([]);
    expect(db.tables.families).toHaveLength(1);
  });

  it('recognises a kid login even once its child_logins row is gone', async () => {
    // A manager can delete the row; a device that was signed in keeps the session.
    seed({ childActive: false });
    db.tables.child_logins = [];
    expect(await ensureActiveFamily(client as never, childUser())).toBe(false);
    expect(db.rpc).toEqual([]);
  });

  it('recognises a child login by its child_logins row even under another address', async () => {
    // user_metadata is the user's to edit, so it is not evidence. The row is
    // written only by the server (and is manager-only under RLS).
    seed({ childActive: false });
    const renamed = { id: CHILD, email: 'emma@example.com', user_metadata: {} };
    expect(await ensureActiveFamily(client as never, renamed)).toBe(false);
    expect(db.rpc).toEqual([]);
  });

  it('refuses rather than guesses when the child-login read fails', async () => {
    seed({ childActive: false });
    db.failReads.add('child_logins');
    const renamed = { id: CHILD, email: 'emma@example.com', user_metadata: {} };
    expect(await ensureActiveFamily(client as never, renamed)).toBe(false);
    expect(db.rpc).toEqual([]);
  });

  it('still provisions an ordinary signup (control)', async () => {
    seed({ childActive: false });
    const newcomer = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: 'sam@example.com', user_metadata: { full_name: 'Sam Lee' } };
    expect(await ensureActiveFamily(client as never, newcomer)).toBe(true);
    expect(db.rpc.map((call) => call.name)).toEqual(['ensure_family_for_user']);
    expect(parentRowsFor(newcomer.id)).toHaveLength(1);
  });

  it('leaves a child who is still in the family exactly where they are (control)', async () => {
    seed({ childActive: true });
    expect(await ensureActiveFamily(client as never, childUser())).toBe(true);
    expect(db.rpc).toEqual([]);
  });
});

describe('a removed child already signed in on a device', () => {
  it('is sent to the kid sign-in screen, not given a family and not sent into the wizard', async () => {
    seed({ childActive: false });
    db.user = childUser();
    const outcome = await requireUserContext().then(
      (ctx) => ({ role: ctx.active.role, family: ctx.active.familyId }),
      (error: unknown) => (error instanceof RedirectSignal ? { redirect: error.path } : { error: String(error) }),
    );
    expect(outcome).toEqual({ redirect: '/kid-login' });
    expect(db.rpc).toEqual([]);
    expect(parentRowsFor(CHILD)).toEqual([]);
  });

  it('still resolves a child who is in the family (control)', async () => {
    seed({ childActive: true });
    db.user = childUser();
    const ctx = await requireUserContext();
    expect(ctx.active).toMatchObject({ familyId: FAMILY, role: 'child' });
  });
});

describe('a removed child signing in again', () => {
  it('is refused like an unknown username, before any password request', async () => {
    seed({ childActive: false });
    const result = await childSignInAction({ username: 'emma', pin: '1234' });
    expect(result).toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(db.signIns).toEqual([]);
  });

  it('fails closed when the membership read fails', async () => {
    seed({ childActive: true });
    db.failReads.add('family_members');
    const result = await childSignInAction({ username: 'emma', pin: '1234' });
    expect(result).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(db.signIns).toEqual([]);
  });

  it('signs a child who is still in the family in (control)', async () => {
    seed({ childActive: true });
    const result = await childSignInAction({ username: 'emma', pin: '1234' });
    expect(result).toMatchObject({ ok: true });
    expect(db.signIns).toEqual([{ email: syntheticChildEmail('emma') }]);
  });
});
