// requireFeature lets a super administrator through; refuseUnlessEntitled, the
// gate on the endpoints behind those pages, did not. So for a super admin whose
// own family is not on Family+, /dashboard/autopilot and /dashboard/briefing
// rendered and then got 403 from /api/autopilot/scan and /api/ai/briefing
// (2026-09-27 page audit). The endpoint gate now asks the same question, but
// only after the family itself was refused, and a failed lookup stays a refusal.
//
// Review on #585: the question must be asked of the caller the endpoint
// authenticated. /api/ai takes a bearer token ahead of cookies and hands the
// gate that bearer-bound client; asking a fresh cookie client instead let an
// ordinary bearer through on an admin's cookie and refused an admin's bearer
// with no cookie. `isSuperAdmin` itself runs here (only the clients are fake),
// so its credential choice is what is exercised.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type User = { id: string; email: string } | null;

function client(user: User, opts: { fail?: boolean } = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => {
        if (opts.fail) throw new Error('auth unavailable');
        return { data: { user }, error: null };
      }),
    },
    rpc: vi.fn(async () => ({ data: false, error: null })),
  };
}

const ADMIN = { id: 'admin', email: 'site-admin@example.test' };
const ORDINARY = { id: 'ordinary', email: 'parent@example.test' };

const h = vi.hoisted(() => ({
  entitlement: { allowed: false, reason: 'plan', needLevel: 2, planLevel: 1 } as Record<string, unknown>,
  cookie: null as unknown,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/feature-entitlement', () => ({ resolveFeatureEntitlement: async () => h.entitlement }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.cookie }));

const { refuseUnlessEntitled } = await import('@/lib/server/route-feature-gate');

const gate = (db: unknown) => refuseUnlessEntitled(db as never, 'fam', ['/dashboard/autopilot']);

describe('a feature endpoint and the page in front of it', () => {
  beforeEach(() => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', ADMIN.email);
    h.entitlement = { allowed: false, reason: 'plan', needLevel: 2, planLevel: 1 };
    h.cookie = client(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('refuses a family below the plan (control)', async () => {
    expect((await gate(client(ORDINARY)))?.status).toBe(403);
  });

  it('lets a super administrator through, as the page does', async () => {
    expect(await gate(client(ADMIN))).toBeNull();
  });

  it('does not ask who the caller is when the family is entitled', async () => {
    h.entitlement = { allowed: true, planLevel: 2 };
    const db = client(ORDINARY);
    expect(await gate(db)).toBeNull();
    expect(db.auth.getUser).not.toHaveBeenCalled();
  });

  it('treats a failed super-admin lookup as a refusal, never as access', async () => {
    expect((await gate(client(ADMIN, { fail: true })))?.status).toBe(403);
  });

  it('refuses an ordinary bearer even when the browser also carries an admin cookie', async () => {
    h.cookie = client(ADMIN);
    expect((await gate(client(ORDINARY)))?.status).toBe(403);
  });

  it('lets an admin bearer through with no cookie at all', async () => {
    h.cookie = client(null);
    expect(await gate(client(ADMIN))).toBeNull();
  });

  it('asks the client it was given, not the cookie session', async () => {
    const cookie = client(ADMIN);
    h.cookie = cookie;
    await gate(client(ORDINARY));
    expect(cookie.auth.getUser).not.toHaveBeenCalled();
  });
});
