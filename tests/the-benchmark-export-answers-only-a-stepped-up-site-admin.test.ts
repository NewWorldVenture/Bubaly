// GET /api/admin/benchmarks/export through the REAL site-admin gate.
//
// tests/an-export-nobody-recorded-is-not-sent.test.ts drives this handler with
// getUser/isSuperAdmin mocked to a boolean and proves the read-failure 502, the
// CSV and the audit-row 500. tests/the-admin-console-is-a-stepped-up-audited-surface.test.ts
// proves the password-only 403 with isSuperAdmin mocked to true. What neither
// does: let lib/supabase/auth decide, from a session and the super_admins
// table (0008's is_super_admin), so that every family role of a real
// household — and the other household's parent — is shown to be refused,
// and a database-granted admin who stepped up is shown to get a file that
// carries no household's data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  FAMILY_ROLES, HOUSEHOLD_A, HOUSEHOLD_B, MEMBERS_A, NO_FACTOR, PARENT_B, PASSWORD_ONLY, SITE_ADMIN, STEPPED_UP,
  cookieSession, seedTwoHouseholds, type SessionState,
} from './helpers/super-admin-cookie-session';
import { BENCHMARK_CSV_COLUMNS } from '@/lib/network/benchmarks';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';

const h = vi.hoisted(() => ({
  db: null as unknown,
  session: { user: null, assurance: null } as unknown,
}));
vi.mock('@/lib/supabase/server', async () => {
  const { cookieSession: forSession } = await import('./helpers/super-admin-cookie-session');
  return {
    createServer: async () => forSession(h.db as InMemorySupabase, h.session as SessionState),
    createServiceClient: () => h.db,
  };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { GET } = await import('@/app/api/admin/benchmarks/export/route');

let db: InMemorySupabase;
const signIn = (state: SessionState) => { h.session = state; };
const LAST_RUN = new Date(Date.now() - 6 * 3_600_000).toISOString();

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  seedTwoHouseholds(db);
  db.seed('network_aggregates', [
    { id: 'agg-1', scope: 'benchmarks', cohort_key: 'kids:6–9|size:3–4', metric: 'chores_per_child', value: '3-5', count: 40, cohort_size: K_ANONYMITY_FLOOR + 5, computed_at: LAST_RUN },
    { id: 'agg-2', scope: 'benchmarks', cohort_key: 'kids:6–9|size:3–4', metric: 'chores_per_child', value: '6-8', count: 12, cohort_size: K_ANONYMITY_FLOOR + 5, computed_at: LAST_RUN },
    { id: 'agg-3', scope: 'benchmarks', cohort_key: 'kids:10–13|size:1–2', metric: 'chores_per_child', value: '9+', count: 2, cohort_size: K_ANONYMITY_FLOOR - 1, computed_at: LAST_RUN },
  ]);
  // The cookie half (super_admins) is read through db.table, not db.from, so
  // db.log records only what the route itself asked the service client for.
  db.log.length = 0;
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const refusedCallers = [
  ...FAMILY_ROLES.map((role) => [`household A's ${role}`, MEMBERS_A[role]] as const),
  ["household B's parent", PARENT_B] as const,
];

describe('API-972FC3BFEB60 who may export the benchmarks', () => {
  it('API-972FC3BFEB60 signed-out caller is refused 401, no-store, and nothing is read or audited', async () => {
    signIn({ user: null, assurance: null });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'benchmarksExport.signInRequired' });
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it.each(refusedCallers)('API-972FC3BFEB60 %s, stepped up, is refused 403 before any read and nothing is audited', async (_who, user) => {
    signIn({ user, assurance: STEPPED_UP });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: 'benchmarksExport.notAuthorized' });
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('API-972FC3BFEB60 a site admin on a password-only session with an enrolled authenticator is sent to step-up, nothing read', async () => {
    signIn({ user: SITE_ADMIN, assurance: PASSWORD_ONLY });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', stepUp: '/auth/step-up?next=%2Fadmin' });
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('API-972FC3BFEB60 a site admin whose assurance level cannot be read is refused (fails closed), nothing read', async () => {
    signIn({ user: SITE_ADMIN, assurance: null });
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step_up_required');
    expect(db.log).toEqual([]);
  });
});

describe('API-972FC3BFEB60 a stepped-up site admin', () => {
  it('API-972FC3BFEB60 gets the k-anonymous bands as CSV, no household data, and one audit row naming them', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(BENCHMARK_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(csv).toContain('3-5');
    expect(csv).toContain('6-8');
    expect(csv, 'a band under the k floor is not exported').not.toContain('9+');
    for (const secret of [HOUSEHOLD_A, HOUSEHOLD_B, MEMBERS_A.parent.email, PARENT_B.email, 'Household A', 'Household B']) {
      expect(csv).not.toContain(secret);
    }
    expect(new Set(db.log.map((entry) => entry.table))).toEqual(new Set(['network_aggregates', 'audit_logs']));
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({
      family_id: null, actor_id: SITE_ADMIN.id, action: 'export', resource: 'household_benchmarks',
      metadata: { rows: 2, via: 'site_admin' },
    })]);
  });

  it('API-972FC3BFEB60 a site admin with no authenticator enrolled is not asked for a code (opt-in step-up)', async () => {
    signIn({ user: SITE_ADMIN, assurance: NO_FACTOR });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(db.table('audit_logs')).toHaveLength(1);
  });
});
