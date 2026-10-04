// The two site-admin CSV exports write one audit_logs row and then send the
// file. The row is the only record that an operator pulled every support
// ticket — requester names, emails, descriptions — or the benchmark table, and
// it was best-effort: logAudit reported a refused write on the console and the
// route carried on, so the file went out under a 200 and the ledger said
// nothing had. DATA-009 made the lost row visible; this makes it decisive. At
// that point nothing has been sent, so a row that did not land is a 500 the
// operator can retry, the way /api/privacy/export answers a lost
// trust_audit_logs row (API-AE3E5F465E18, API-972FC3BFEB60).
//
// Both handlers are exercised end to end against the in-memory client, so the
// paged read, the CSV, the audit row and the refusals are the real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { TICKET_CSV_COLUMNS } from '@/lib/admin/tickets-csv';
import { BENCHMARK_CSV_COLUMNS } from '@/lib/network/benchmarks';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  isSuperAdmin: vi.fn(),
  service: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ getUser: mocks.getUser, isSuperAdmin: mocks.isSuperAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { GET as exportTickets } from '@/app/api/admin/support-tickets/export/route';
import { GET as exportBenchmarks } from '@/app/api/admin/benchmarks/export/route';
import { logAudit, recordAudit } from '@/lib/server/audit';

const ADMIN = { id: 'super-admin-1', email: 'ops@example.com' };
const REFUSED = { code: '42501', message: 'permission denied for table audit_logs' };

const TICKETS = [
  { id: 't1', ticket_number: 'TKT-1', status: 'open', priority: 'high', category: 'billing', subject: 'Charged twice', requester_name: 'Ana', requester_email: 'ana@example.com', assigned_agent_name: null, description: 'Two charges on the 3rd', updated_at: '2026-10-02T10:00:00Z' },
  { id: 't2', ticket_number: 'TKT-2', status: 'resolved', priority: 'low', category: 'account', subject: 'Rename family', requester_name: 'Ben', requester_email: 'ben@example.com', assigned_agent_name: 'Kim', description: 'Please rename us', updated_at: '2026-10-01T10:00:00Z' },
  { id: 't3', ticket_number: 'TKT-3', status: 'open', priority: 'normal', category: 'other', subject: '=HYPERLINK("x")', requester_name: 'Cy', requester_email: 'cy@example.com', assigned_agent_name: null, description: 'formula in a subject', updated_at: '2026-09-30T10:00:00Z' },
];
const AGGREGATES = [
  { id: 'a1', scope: 'benchmarks', cohort_key: 'kids:6–9|size:3–4', metric: 'chores_per_child', value: '3-5', count: 40, cohort_size: K_ANONYMITY_FLOOR + 5, computed_at: '2026-10-01T00:00:00Z' },
  { id: 'a2', scope: 'benchmarks', cohort_key: 'kids:6–9|size:3–4', metric: 'chores_per_child', value: '6-8', count: 12, cohort_size: K_ANONYMITY_FLOOR + 5, computed_at: '2026-10-01T00:00:00Z' },
  // Below the k-anonymity floor: the read excludes it, so it must not be counted or exported.
  { id: 'a3', scope: 'benchmarks', cohort_key: 'kids:10–13|size:1–2', metric: 'chores_per_child', value: '3-5', count: 3, cohort_size: K_ANONYMITY_FLOOR - 1, computed_at: '2026-10-01T00:00:00Z' },
];

let db: InMemorySupabase;
let errors: unknown[][];

function household() {
  const fresh = createInMemorySupabase();
  fresh.seed('support_tickets', TICKETS);
  fresh.seed('network_aggregates', AGGREGATES);
  return fresh;
}

/**
 * Make one table answer every call with `error`, the way PostgREST does — a
 * RESOLVED error, never a rejection, because that is the shape a dead catch
 * cannot see (DATA-009). Returns the rows whose insert was attempted, so a test
 * can say what the ledger WOULD have recorded.
 */
function refuse(client: InMemorySupabase, table: string, error: { code: string; message: string }) {
  const realFrom = client.from.bind(client);
  const attempted: unknown[] = [];
  const reply = { data: null, error, count: null, status: 403, statusText: 'Forbidden' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      if (prop === 'insert') return (row: unknown) => { attempted.push(row); return chain; };
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === table ? chain : realFrom(name))) as InMemorySupabase['from'];
  return attempted;
}

beforeEach(() => {
  db = household();
  errors = [];
  mocks.service.mockImplementation(() => db);
  mocks.getUser.mockResolvedValue(ADMIN);
  mocks.isSuperAdmin.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); });

const auditRows = () => db.table('audit_logs');

describe.each([
  {
    name: 'support tickets', GET: exportTickets, table: 'support_tickets', resource: 'support_tickets',
    filename: /^attachment; filename="support-tickets-\d{4}-\d{2}-\d{2}T[\d-]+Z\.csv"$/, columns: TICKET_CSV_COLUMNS, rows: 3, readFailed: 'supportTickets.couldNotLoadSupportTickets',
  },
  {
    name: 'household benchmarks', GET: exportBenchmarks, table: 'network_aggregates', resource: 'household_benchmarks',
    filename: /^attachment; filename="household-benchmarks-\d{4}-\d{2}-\d{2}\.csv"$/, columns: BENCHMARK_CSV_COLUMNS, rows: 2, readFailed: 'benchmarksExport.readFailed',
  },
])('the $name export', ({ GET, table, resource, filename, columns, rows, readFailed }) => {
  it('refuses a signed-out caller with 401, no-store, before any read', async () => {
    mocks.getUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'benchmarksExport.signInRequired' });
    expect(db.log, 'nothing may be read for a stranger').toEqual([]);
  });

  it('refuses a signed-in parent with 403, no-store, before any read', async () => {
    mocks.isSuperAdmin.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'benchmarksExport.notAuthorized' });
    expect(db.log).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it('answers a failed read with 502 and writes no audit row, so a refused read is not an empty file', async () => {
    refuse(db, table, { code: '57014', message: 'canceling statement due to statement timeout' });
    const res = await GET();
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: readFailed });
    expect(auditRows(), 'an export that did not happen is not recorded as one').toEqual([]);
  });

  it('sends the whole table as CSV after recording the export, with the row count the ledger needs', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(filename);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // The benchmarks CSV ends its lines with CRLF, the tickets CSV with LF.
    const lines = (await res.text()).trim().split(/\r?\n/);
    expect(lines[0]).toBe(columns.join(','));
    expect(lines).toHaveLength(rows + 1);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      family_id: null, actor_id: ADMIN.id, action: 'export', resource,
      metadata: { rows, via: 'site_admin' },
    });
    expect(errors).toEqual([]);
  });

  it('sends NOTHING when the audit row is refused: 500, retryable, no-store, and the refusal is reported', async () => {
    // The whole change in one case. Before it, this request answered 200 with
    // the full CSV and one console line; the ledger had no row.
    const attempted = refuse(db, 'audit_logs', REFUSED);
    const res = await GET();
    expect(res.status, 'a file nobody recorded must not leave the building').toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.json()).toEqual({ error: 'audit_failed', retryable: true });
    // The row that was refused carried what WOULD have gone out, so a retry
    // after the fix records the same fact.
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toMatchObject({ actor_id: ADMIN.id, action: 'export', resource, metadata: { rows, via: 'site_admin' } });
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toMatch(/export audit row was not written; nothing sent$/);
    expect(errors[0][1]).toMatchObject(REFUSED);
  });

  it('sends nothing either when the audit client throws while building the query', async () => {
    const broken = { from: (name: string) => { if (name === 'audit_logs') throw new Error('client has no URL'); return db.from(name); } };
    mocks.service.mockImplementation(() => broken);
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'audit_failed', retryable: true });
    expect(errors).toHaveLength(1);
  });
});

describe('recordAudit says whether the row landed, and logAudit is built on it', () => {
  const ENTRY = { familyId: null, actorId: ADMIN.id, action: 'export', resource: 'support_tickets', metadata: { rows: 3 } };
  const client = () => db as unknown as SupabaseClient<Database>;

  it('answers ok when the row is in the table', async () => {
    await expect(recordAudit(client(), ENTRY)).resolves.toEqual({ ok: true });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ family_id: null, actor_id: ADMIN.id, resource_id: null, metadata: { rows: 3 } });
    expect(errors, 'recording is the caller\'s business; a success is silent').toEqual([]);
  });

  it('hands back the database\'s own error when the row was refused, and does not log it itself', async () => {
    refuse(db, 'audit_logs', REFUSED);
    await expect(recordAudit(client(), ENTRY)).resolves.toEqual({ ok: false, error: REFUSED });
    expect(errors).toEqual([]);
  });

  it('never rejects: a client that throws while building the query is an outcome, not an exception', async () => {
    const throwing = { from: () => { throw new Error('client has no URL'); } } as unknown as SupabaseClient<Database>;
    const outcome = await recordAudit(throwing, ENTRY);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error).toBeInstanceOf(Error);
  });

  it('logAudit keeps its contract through the shared write: a lost row is one console line, never a throw', async () => {
    refuse(db, 'audit_logs', REFUSED);
    await expect(logAudit(client(), ENTRY)).resolves.toBeUndefined();
    expect(errors).toEqual([['[audit] failed to write log', REFUSED]]);
  });
});
