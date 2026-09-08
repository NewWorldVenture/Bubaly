import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';

// Privacy Center › "Export my family's data".
//
// The export is a view of what the caller could already open, written down —
// role-scoped through the services, all-or-nothing on a failed read, and
// recorded in trust_audit_logs BEFORE a byte is sent. Each of those is a
// promise the Privacy Center makes in words, so each is pinned here.

const mocks = vi.hoisted(() => ({
  getUserContext: vi.fn(),
  createServer: vi.fn(),
  ledgerWriter: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.getUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/trust/ledger', () => ({ ledgerWriter: mocks.ledgerWriter }));

import { EXPORT_SECTIONS, buildFamilyExport, exportFilename, sectionsForRole, serializeExport } from '@/lib/privacy/export';
import { GET } from '@/app/api/privacy/export/route';

const FAMILY = 'fam-1';
const today = new Date().toISOString().slice(0, 10);

type Aal = { currentLevel: string; nextLevel: string };

function household(aal: Aal = { currentLevel: 'aal1', nextLevel: 'aal1' }) {
  const db = createInMemorySupabase({
    userId: 'user-parent',
    rpc: { rate_limit_hit: () => [{ allowed: true, retry_after: 0 }] },
  });
  // The guard reads the level from the session; the fake has no session.
  Object.assign(db.auth, { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error: null }) } });

  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: 'teal', avatar_url: null },
    { id: 'mem-teen', family_id: FAMILY, user_id: 'user-teen', display_name: 'Sam', role: 'teen', is_active: true, birthday: '2011-04-02', color: 'amber', avatar_url: null },
  ]);
  db.seed('calendar_events', [{ id: 'ev-1', family_id: FAMILY, title: 'Soccer', starts_at: `${today}T15:00:00Z`, ends_at: `${today}T16:00:00Z`, category: 'sports', assignee_id: 'mem-teen' }]);
  db.seed('transactions', [{ id: 'tx-1', family_id: FAMILY, name: 'Groceries', merchant: 'Market', amount: 84.2, category: 'food', date: today, type: 'expense', member_id: null, account_id: null }]);
  db.seed('documents', [
    { id: 'doc-1', family_id: FAMILY, title: 'School calendar', category: 'school', mime_type: 'application/pdf', size_bytes: 10, expires_at: null, member_id: null, asset_id: null, is_secure: false, storage_path: `${FAMILY}/a.pdf` },
    { id: 'doc-2', family_id: FAMILY, title: 'Passports', category: 'identity', mime_type: 'application/pdf', size_bytes: 10, expires_at: null, member_id: null, asset_id: null, is_secure: true, storage_path: `${FAMILY}/b.pdf` },
  ]);
  return db;
}

function scopeFor(db: InMemorySupabase, role: 'parent' | 'teen'): ServiceScope {
  return {
    db: db as unknown as ServiceScope['db'],
    familyId: FAMILY,
    userId: role === 'parent' ? 'user-parent' : 'user-teen',
    memberId: role === 'parent' ? 'mem-parent' : 'mem-teen',
    role,
    actorKind: 'member',
    tz: 'America/New_York',
  };
}

function ctxFor(role: 'parent' | 'teen', userId = role === 'parent' ? 'user-parent' : 'user-teen'): UserContext {
  const memberId = role === 'parent' ? 'mem-parent' : 'mem-teen';
  return {
    user: { id: userId, email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY, role, member: { id: memberId }, family: { id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' } },
  } as unknown as UserContext;
}

/** A builder for one table that answers every terminal call with `error`. */
function failing(db: InMemorySupabase, table: string, error: { code: string; message: string }) {
  const realFrom = db.from.bind(db);
  const reply = { data: null, error, count: null, status: 500, statusText: 'Internal Server Error' };
  const chain: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(reply).then(resolve);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(reply);
      return () => proxy;
    },
  });
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => (t === table ? proxy : realFrom(t));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe('sectionsForRole', () => {
  it('gives parents and adults every section and withholds the finances from everyone else', () => {
    const all = EXPORT_SECTIONS.map((s) => s.key);
    expect(sectionsForRole('parent')).toEqual(all);
    expect(sectionsForRole('adult')).toEqual(all);
    for (const role of ['teen', 'child', 'caregiver', 'guest', null]) {
      const keys = sectionsForRole(role);
      expect(keys, String(role)).not.toContain('finances');
      expect(keys.length).toBe(all.length - 1);
    }
  });
});

describe('buildFamilyExport', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('builds a parent\'s export through the services: finances present, both documents listed, nothing withheld', async () => {
    const db = household();
    const built = await buildFamilyExport(scopeFor(db, 'parent'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const data = built.data;
    expect(data.format).toBe('bubaly-family-export');
    expect(data.family).toEqual({ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' });
    expect(data.exportedBy).toEqual({ userId: 'user-parent', memberId: 'mem-parent', role: 'parent' });
    expect(data.withheld).toEqual([]);
    expect(data.sections.map((s) => s.key)).toEqual(EXPORT_SECTIONS.map((s) => s.key));

    const by = Object.fromEntries(data.sections.map((s) => [s.key, s]));
    expect(by.members.count).toBe(2);
    expect(by.calendar.count).toBe(1);
    expect(by.finances.count).toBe(1);
    expect((by.finances.data as { transactions: { name: string }[] }).transactions[0].name).toBe('Groceries');
    expect(by.documents.count).toBe(2);
    // A window that did not hit the service ceiling says so.
    expect(by.calendar).toMatchObject({ limit: 200, truncated: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('builds a teen\'s export with the finances withheld and the sensitive document omitted by the documents service', async () => {
    const db = household();
    const built = await buildFamilyExport(scopeFor(db, 'teen'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data.withheld).toEqual(['finances']);
    expect(built.data.sections.map((s) => s.key)).not.toContain('finances');
    const docs = built.data.sections.find((s) => s.key === 'documents')!;
    expect(docs.count).toBe(1);
    expect((docs.data as { title: string }[]).map((d) => d.title)).toEqual(['School calendar']);
  });

  it('fails the whole export when one section cannot be read, naming the section and logging it', async () => {
    const db = household();
    failing(db, 'transactions', { code: '57014', message: 'canceling statement due to statement timeout' });
    const built = await buildFamilyExport(scopeFor(db, 'parent'));
    expect(built).toEqual({ ok: false, failed: [{ key: 'finances', error: expect.any(String) }] });
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[privacy] export finances read failed');
  });
});

describe('serializeExport', () => {
  it('streams ordinary JSON that parses back to the export, one section per chunk', async () => {
    const db = household();
    const built = await buildFamilyExport(scopeFor(db, 'teen'));
    if (!built.ok) throw new Error('export failed');
    const text = await readAll(serializeExport(built.data));
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('bubaly-family-export');
    expect(parsed.withheld).toEqual(['finances']);
    expect(parsed.sections.map((s: { key: string }) => s.key)).toEqual(built.data.sections.map((s) => s.key));
    expect(parsed.sections.find((s: { key: string }) => s.key === 'members').count).toBe(2);
  });

  it('names the file after the family and the day', () => {
    expect(exportFilename('The Riveras', '2026-09-07T12:00:00.000Z')).toBe('bubaly-export-the-riveras-2026-09-07.json');
    expect(exportFilename('  ', '2026-09-07T12:00:00.000Z')).toBe('bubaly-export-family-2026-09-07.json');
    expect(exportFilename('Ünïcode "quotes" & co', '2026-01-02T00:00:00Z')).toBe('bubaly-export-unicode-quotes-co-2026-01-02.json');
  });
});

describe('GET /api/privacy/export', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getUserContext.mockReset();
    mocks.createServer.mockReset();
    mocks.ledgerWriter.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  function wire(db: InMemorySupabase, ctx: UserContext | null) {
    mocks.getUserContext.mockResolvedValue(ctx);
    mocks.createServer.mockResolvedValue(db);
    mocks.ledgerWriter.mockImplementation(async (fallback: unknown) => fallback);
  }

  it('refuses a signed-out caller', async () => {
    wire(household(), null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('streams a parent\'s export as an attachment and records the download in the trust ledger first', async () => {
    const db = household();
    wire(db, ctxFor('parent', 'user-route-ok'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="bubaly-export-the-riveras-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = JSON.parse(await res.text());
    expect(body.sections.map((s: { key: string }) => s.key)).toContain('finances');

    const ledger = db.table('trust_audit_logs');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      family_id: FAMILY,
      actor_kind: 'member',
      actor_id: 'mem-parent',
      domain: 'privacy',
      capability: 'export',
      decision: 'executed',
    });
    expect((ledger[0].context as { sections: Record<string, number>; role: string }).sections.finances).toBe(1);
    expect((ledger[0].context as { role: string }).role).toBe('parent');
  });

  it('asks a manager with an enrolled authenticator to step up before a whole-family download, and records nothing', async () => {
    const db = household({ currentLevel: 'aal1', nextLevel: 'aal2' });
    wire(db, ctxFor('parent', 'user-route-stepup'));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', stepUp: '/auth/step-up?next=%2Fdashboard%2Fsettings%23privacy' });
    expect(db.table('trust_audit_logs')).toHaveLength(0);
  });

  it('fails closed with a retryable 502 when a section cannot be read — no partial file, no ledger row', async () => {
    const db = household();
    failing(db, 'calendar_events', { code: '42501', message: 'permission denied for table calendar_events' });
    wire(db, ctxFor('parent', 'user-route-fail'));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'export_failed', failed: ['calendar'], retryable: true });
    expect(db.table('trust_audit_logs')).toHaveLength(0);
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[privacy] export calendar read failed');
  });

  it('refuses to send an export the ledger would not record', async () => {
    const db = household();
    wire(db, ctxFor('parent', 'user-route-ledger'));
    const ledgerDb = createInMemorySupabase();
    failing(ledgerDb, 'trust_audit_logs', { code: '42501', message: 'new row violates row-level security policy' });
    mocks.ledgerWriter.mockResolvedValue(ledgerDb);
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'audit_failed', retryable: true });
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[privacy] export ledger write failed');
  });

  it('scopes a teen\'s download to what a teen may read', async () => {
    const db = household();
    wire(db, ctxFor('teen'));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.withheld).toEqual(['finances']);
    expect(body.sections.map((s: { key: string }) => s.key)).not.toContain('finances');
    expect(db.table('trust_audit_logs')[0]).toMatchObject({ actor_id: 'mem-teen' });
  });
});
