// "Invite admin" must not demote a super-admin on paper while their access
// stands.
//
// inviteAdminAction upserts public.admin_users ON CONFLICT (email), and the
// invite form is the only place a roster role is chosen. So inviting someone
// already on the roster rewrites their row. Invited as Viewer, a current
// super-admin became a pending Viewer on /admin/admins and in the audit log,
// the operator saw "Invited", and their public.super_admins grant (what
// isSuperAdmin actually reads) was never touched: full console access, under a
// roster entry and an audit row both saying "reports, view only".
//
// app/(app)/admin/admins/actions.ts already says the roster is not access and
// fixed revoke/deactivate for exactly this ("changed only the roster, report
// success, and leave them with full access"); this is the same defect on the
// invite path.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

type Op = { table: string; kind: string; payload?: unknown; filters: [string, unknown][] };
type Answer = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  ops: [] as { table: string; kind: string; payload?: unknown; filters: [string, unknown][] }[],
  /** Emails holding a public.super_admins grant. */
  grants: new Set<string>(),
  grantReadFails: false,
}));

function respond(op: Op): Answer {
  if (op.table === 'super_admins' && op.kind === 'select') {
    if (h.grantReadFails) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const email = op.filters.find(([col]) => col === 'email')?.[1] as string;
    return { data: h.grants.has(email) ? { email } : null, error: null };
  }
  if (op.table === 'admin_users' && op.kind === 'upsert') return { data: { id: '33333333-3333-4333-8333-333333333333' }, error: null };
  return { data: null, error: null };
}

function builder(table: string) {
  const op: Op = { table, kind: 'select', filters: [] };
  let started = false;
  const settle = () => { h.ops.push(op); return Promise.resolve(respond(op)); };
  const b: Record<string, unknown> = {
    select() { if (!started) { op.kind = 'select'; started = true; } return b; },
    upsert(payload: unknown) { op.kind = 'upsert'; op.payload = payload; started = true; return b; },
    insert(payload: unknown) { op.kind = 'insert'; op.payload = payload; started = true; return b; },
    eq(col: string, v: unknown) { op.filters.push([col, v]); return b; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return b;
}

vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: '11111111-1111-4111-8111-111111111111', email: 'acting.admin@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { inviteAdminAction } = await import('@/app/(app)/admin/admins/actions');

const invite = (email: string, role: string) => {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('admin_role', role);
  return inviteAdminAction(fd);
};
const rosterWrites = () => h.ops.filter((o) => o.table === 'admin_users' && o.kind !== 'select');

beforeEach(() => {
  h.ops = [];
  h.grants = new Set(['bob.admin@example.com']);
  h.grantReadFails = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an admin invite cannot write a lower role over live super-admin access', () => {
  it('refuses to make a current super-admin a Viewer, and writes nothing', async () => {
    await expect(invite('bob.admin@example.com', 'viewer')).resolves.toEqual({
      ok: false, error: EN_US['actions.removeSuperAdminBeforeChangingRole'],
    });
    expect(rosterWrites()).toEqual([]);
  });

  it.each(['administrator', 'content_manager', 'billing_manager', 'moderator'])('refuses %s too', async (role) => {
    await expect(invite('Bob.Admin@example.com', role)).resolves.toMatchObject({ ok: false });
    expect(rosterWrites()).toEqual([]);
  });

  it('refuses for the built-in owner, whose access no roster row can change', async () => {
    await expect(invite('daniel.hughen@gmail.com', 'viewer')).resolves.toEqual({
      ok: false, error: EN_US['actions.thisAdminIsSetVia'],
    });
    expect(rosterWrites()).toEqual([]);
  });

  it('does not take a failed access read for "no access"', async () => {
    h.grantReadFails = true;
    const result = await invite('bob.admin@example.com', 'viewer');
    expect(result.ok).toBe(false);
    expect(rosterWrites()).toEqual([]);
  });

  it('control: a super-admin can still be (re)invited as super administrator', async () => {
    await expect(invite('bob.admin@example.com', 'super_administrator')).resolves.toEqual({ ok: true });
    expect(rosterWrites()).toHaveLength(1);
  });

  it('control: someone without console access is invited at any role', async () => {
    await expect(invite('new.staff@example.com', 'viewer')).resolves.toEqual({ ok: true });
    expect(rosterWrites()).toEqual([expect.objectContaining({ kind: 'upsert', payload: expect.objectContaining({ email: 'new.staff@example.com', admin_role: 'viewer' }) })]);
  });
});
