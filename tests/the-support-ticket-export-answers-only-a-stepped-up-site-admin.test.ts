// GET /api/admin/support-tickets/export through the REAL site-admin gate.
//
// tests/an-export-nobody-recorded-is-not-sent.test.ts drives this handler with
// getUser/isSuperAdmin mocked to a boolean and proves the read-failure 502, the
// CSV shape, formula escaping is the lib's, and the audit-row 500.
// tests/the-admin-console-is-a-stepped-up-audited-surface.test.ts proves the
// password-only 403 with isSuperAdmin mocked to true. What neither does: let
// lib/supabase/auth decide from a session and the super_admins table (0008's
// is_super_admin), so every family role of a real household — and the other
// household's parent, whose own ticket is in the table — is shown to be
// refused without the file, and a database-granted, stepped-up admin is shown
// to get every household's tickets with one audit row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  FAMILY_ROLES, MEMBERS_A, NO_FACTOR, PARENT_B, PASSWORD_ONLY, SITE_ADMIN, STEPPED_UP,
  seedTwoHouseholds, type SessionState,
} from './helpers/super-admin-cookie-session';
import { TICKET_CSV_COLUMNS } from '@/lib/admin/tickets-csv';

const h = vi.hoisted(() => ({
  db: null as unknown,
  session: { user: null, assurance: null } as unknown,
}));
vi.mock('@/lib/supabase/server', async () => {
  const { cookieSession } = await import('./helpers/super-admin-cookie-session');
  return {
    createServer: async () => cookieSession(h.db as InMemorySupabase, h.session as SessionState),
    createServiceClient: () => h.db,
  };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { GET } = await import('@/app/api/admin/support-tickets/export/route');

let db: InMemorySupabase;
const signIn = (state: SessionState) => { h.session = state; };

const TICKET_A = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000c1', ticket_number: 'TKT-A1', status: 'open', priority: 'high', category: 'billing',
  subject: 'Charged twice', requester_name: 'Parent A', requester_email: MEMBERS_A.parent.email, assigned_agent_name: null,
  description: 'Household A was charged twice', created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-02T10:00:00Z',
};
const TICKET_B = {
  id: 'bbbbbbbb-0000-4000-8000-0000000000c1', ticket_number: 'TKT-B1', status: 'resolved', priority: 'low', category: 'account',
  subject: 'Rename family', requester_name: 'Parent B', requester_email: PARENT_B.email, assigned_agent_name: 'Kim',
  description: 'Household B wants a new name', created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-02T10:00:00Z',
};

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  seedTwoHouseholds(db);
  db.seed('support_tickets', [TICKET_B, TICKET_A]);
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

describe('API-AE3E5F465E18 who may export the support tickets', () => {
  it('API-AE3E5F465E18 signed-out caller is refused 401, no-store, and nothing is read or audited', async () => {
    signIn({ user: null, assurance: null });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'benchmarksExport.signInRequired' });
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it.each(refusedCallers)('API-AE3E5F465E18 %s, stepped up, is refused 403 with no ticket in the body and nothing read or audited', async (_who, user) => {
    signIn({ user, assurance: STEPPED_UP });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'benchmarksExport.notAuthorized' });
    expect(body).not.toContain('TKT-');
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('API-AE3E5F465E18 a site admin on a password-only session with an enrolled authenticator is sent to step-up, nothing read', async () => {
    signIn({ user: SITE_ADMIN, assurance: PASSWORD_ONLY });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', stepUp: '/auth/step-up?next=%2Fadmin' });
    expect(db.log).toEqual([]);
    expect(db.table('audit_logs')).toEqual([]);
  });

  it('API-AE3E5F465E18 a site admin whose assurance level cannot be read is refused (fails closed), nothing read', async () => {
    signIn({ user: SITE_ADMIN, assurance: null });
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('step_up_required');
    expect(db.log).toEqual([]);
  });
});

describe('API-AE3E5F465E18 a stepped-up site admin', () => {
  it('API-AE3E5F465E18 gets every household\'s tickets, newest update first, and one audit row with the count', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="support-tickets-\d{4}-\d{2}-\d{2}T[\d-]+Z\.csv"$/);
    const lines = (await res.text()).trim().split('\n');
    expect(lines).toEqual([
      TICKET_CSV_COLUMNS.join(','),
      'TKT-A1,open,high,billing,Charged twice,Parent A,parent.a@example.com,,2026-10-01T09:00:00Z,2026-10-02T10:00:00Z,Household A was charged twice',
      'TKT-B1,resolved,low,account,Rename family,Parent B,parent.b@example.com,Kim,2026-09-01T09:00:00Z,2026-09-02T10:00:00Z,Household B wants a new name',
    ]);
    expect(db.table('support_tickets')).toHaveLength(2);
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({
      family_id: null, actor_id: SITE_ADMIN.id, action: 'export', resource: 'support_tickets',
      metadata: { rows: 2, via: 'site_admin' },
    })]);
  });

  it('API-AE3E5F465E18 a site admin with no authenticator enrolled is not asked for a code (opt-in step-up)', async () => {
    signIn({ user: SITE_ADMIN, assurance: NO_FACTOR });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(db.table('audit_logs')).toHaveLength(1);
  });
});
