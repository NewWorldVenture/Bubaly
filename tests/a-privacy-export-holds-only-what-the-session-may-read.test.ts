// GET /api/privacy/export (Register B API-BB4FF5888E65), end to end over the
// in-memory database: the real route, the real getUserContext reading the
// session's memberships, the real services, the real ledger write.
//
// What the existing files already prove, and this one does not repeat:
//  - tests/an-export-is-not-a-cross-site-navigation.test.ts: the cross-site
//    navigation refusal and its order before any session read.
//  - tests/a-family-export-keeps-the-acting-readers-record-boundaries.test.ts:
//    parent / adult / child / guest boundaries on memories, documents, members
//    and preferences, with a MOCKED getUserContext and calendar, school,
//    sports, todos, trips, groceries, routines and finances left empty.
//  - tests/privacy-export.test.ts: section-per-role table, step-up, the 502 on
//    a failed section and the 500 on a refused ledger write.
//
// What is added here: the context is derived from the session (no mocked
// actor), every section is seeded in BOTH households, teen and caregiver and a
// kid-login child are covered, a user who belongs to both households gets only
// the active one, a household-B id in the query string is ignored, and a
// rate-limited or signed-out caller writes no ledger row.
//
// The in-memory database applies no RLS, so every boundary asserted here is
// one the route and its services draw themselves (family_id filters in every
// service, sectionsForRole, assertFinanceReader, listMemories / listDocuments
// role filters). RLS is a second layer this file does not exercise.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import type { FamilyExport } from '@/lib/privacy/export';

const state = vi.hoisted(() => ({
  db: null as unknown,
  assurance: { currentLevel: 'aal1', nextLevel: 'aal1' } as { currentLevel: string; nextLevel: string },
}));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => state.db,
}));
// The in-process limiter is a per-instance cache in front of the durable one;
// it is held open so cases that reuse a user id are not throttled by each
// other. The durable limiter (rate_limit_hit over the database) stays real.
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true, retryAfter: 0 }) }));

const { GET } = await import('@/app/api/privacy/export/route');

const NOW = new Date('2026-10-14T15:00:00.000Z');
const FAMILY = { A: '0a000000-0000-4000-8000-00000000000a', B: '0b000000-0000-4000-8000-00000000000b' } as const;
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = typeof ROLES[number];
type Household = keyof typeof FAMILY;
const userOf = (h: Household, role: string) => `user-${h}-${role}`;
const memberOf = (h: Household, role: string) => `member-${h}-${role}`;
const DUAL_USER = 'user-dual';

/** Markers every section's row carries, per household. */
const MARKERS = ['EVENT', 'TODO', 'TRIP', 'GROCERY_ITEM', 'SCHOOL_CLASS', 'SCHOOL_EVENT', 'TEAM', 'ROUTINE', 'FACT_PUBLIC', 'DOC_PUBLIC'] as const;
const MANAGER_ONLY_MARKERS = ['TRANSACTION', 'FACT_PRIVATE', 'DOC_SECURE', 'MEMBER_REMOVED'] as const;

function seed(db: InMemorySupabase) {
  const day = NOW.toISOString().slice(0, 10);
  const soon = new Date(NOW.getTime() + 86_400_000).toISOString();
  const later = new Date(NOW.getTime() + 90_000_000).toISOString();
  for (const h of ['A', 'B'] as const) {
    const familyId = FAMILY[h];
    db.seed('families', [{ id: familyId, name: `HOUSEHOLD_${h}`, timezone: 'UTC' }]);
    db.seed('family_members', [
      ...ROLES.map((role, i) => ({
        id: memberOf(h, role), family_id: familyId, user_id: userOf(h, role), role, is_active: true,
        display_name: `${h}_MEMBER_${role}`, birthday: null, avatar_url: null, color: 'teal',
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
      { id: `member-${h}-removed`, family_id: familyId, user_id: `user-${h}-removed`, role: 'adult', is_active: false,
        display_name: `${h}_MEMBER_REMOVED`, birthday: null, avatar_url: null, color: 'blue', created_at: '2026-01-09T00:00:00.000Z' },
    ]);
    db.seed('user_preferences', ROLES.map((role) => ({
      user_id: userOf(h, role), theme: 'dark', push_enabled: true, email_enabled: true,
      notification_prefs: { marker: `${h}_PREF_${role}` }, active_family_id: familyId,
    })));
    db.seed('family_facts', [
      { family_id: familyId, category: 'preference', label: `${h}_FACT_PUBLIC`, value: 'likes green', notes: null, is_pinned: false, member_id: null },
      { family_id: familyId, category: 'medical', label: `${h}_FACT_PRIVATE`, value: 'private value', notes: null, is_pinned: false, member_id: null },
    ]);
    db.seed('documents', [
      { family_id: familyId, title: `${h}_DOC_PUBLIC`, category: 'school', is_secure: false, storage_path: `${familyId}/public.pdf`, mime_type: 'application/pdf', size_bytes: 10, expires_at: null, member_id: null, asset_id: null },
      { family_id: familyId, title: `${h}_DOC_SECURE`, category: 'school', is_secure: true, storage_path: `${familyId}/secure.pdf`, mime_type: 'application/pdf', size_bytes: 10, expires_at: null, member_id: null, asset_id: null },
    ]);
    db.seed('calendar_events', [{ family_id: familyId, title: `${h}_EVENT`, starts_at: soon, ends_at: later, all_day: false, assignee_id: null, recurrence: null }]);
    db.seed('todo_items', [{ family_id: familyId, title: `${h}_TODO`, is_done: false, due_date: day }]);
    db.seed('vacations', [{ family_id: familyId, name: `${h}_TRIP`, destination: `${h}_TRIP`, status: 'planning', start_date: day, end_date: day }]);
    db.seed('grocery_lists', [{ id: `list-${h}`, family_id: familyId, name: 'Groceries', is_archived: false, archived_at: null }]);
    db.seed('grocery_items', [{ family_id: familyId, list_id: `list-${h}`, name: `${h}_GROCERY_ITEM`, is_checked: false }]);
    db.seed('school_classes', [{ family_id: familyId, subject: `${h}_SCHOOL_CLASS`, member_id: memberOf(h, 'child') }]);
    db.seed('school_events', [{ family_id: familyId, title: `${h}_SCHOOL_EVENT`, starts_at: soon, member_id: memberOf(h, 'child') }]);
    db.seed('teams', [{ family_id: familyId, team_name: `${h}_TEAM`, is_active: true, member_id: memberOf(h, 'teen') }]);
    db.seed('family_automation_rules', [{ family_id: familyId, name: `${h}_ROUTINE`, prompt: `${h}_ROUTINE`, schedule_kind: 'cron', is_enabled: true }]);
    db.seed('transactions', [{ family_id: familyId, name: `${h}_TRANSACTION`, amount: 12.5, type: 'expense', category: 'food', date: day }]);
  }
  // One account that is a guest in A and the parent of B, with A active.
  db.seed('family_members', [
    { id: 'member-dual-A', family_id: FAMILY.A, user_id: DUAL_USER, role: 'guest', is_active: true, display_name: 'A_MEMBER_dual', created_at: '2026-01-10T00:00:00.000Z' },
    { id: 'member-dual-B', family_id: FAMILY.B, user_id: DUAL_USER, role: 'parent', is_active: true, display_name: 'B_MEMBER_dual', created_at: '2026-01-10T00:00:00.000Z' },
  ]);
  db.seed('user_preferences', [{ user_id: DUAL_USER, theme: 'dark', push_enabled: true, email_enabled: true, notification_prefs: { marker: 'DUAL_PREF' }, active_family_id: FAMILY.A }]);
}

function database(userId: string | null, email: string | null = null) {
  const db = createInMemorySupabase({ userId, rpc: { rate_limit_hit: rateLimitHit } });
  Object.assign(db.auth, {
    getUser: async () => ({ data: { user: userId ? { id: userId, email } : null }, error: null }),
    getSession: async () => ({ data: { session: userId ? { access_token: 'fixture-access-token' } : null }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: state.assurance, error: null }) },
  });
  seed(db);
  return db;
}

const exportRequest = (query = '') => new NextRequest(`https://bubaly.example.com/api/privacy/export${query}`, {
  headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
});

async function exportAs(userId: string | null, opts: { email?: string; query?: string; fault?: Parameters<typeof withFaults>[1] } = {}) {
  const db = database(userId, opts.email ?? null);
  state.db = opts.fault ? withFaults(db, opts.fault) : db;
  const response = await GET(exportRequest(opts.query));
  const raw = await response.text();
  return { db, response, raw };
}

const ledger = (db: InMemorySupabase) => db.table('trust_audit_logs');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.assurance = { currentLevel: 'aal1', nextLevel: 'aal1' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('who may download a family export', () => {
  it('API-BB4FF5888E65 refuses a signed-out caller with 401 and records nothing', async () => {
    const { db, response, raw } = await exportAs(null);
    expect(response.status).toBe(401);
    expect(JSON.parse(raw)).toEqual({ error: 'unauthorized' });
    expect(ledger(db)).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
  });

  it('API-BB4FF5888E65 refuses a signed-in account with no family with 403 and records nothing', async () => {
    const { db, response, raw } = await exportAs('user-without-family');
    expect(response.status).toBe(403);
    expect(JSON.parse(raw)).toEqual({ error: 'no_family' });
    expect(ledger(db)).toEqual([]);
  });

  it('API-BB4FF5888E65 answers a sixth export in the window with 429 and writes no sixth ledger row', async () => {
    const db = database(userOf('A', 'teen'));
    state.db = db;
    for (let i = 0; i < 5; i++) expect((await GET(exportRequest())).status).toBe(200);
    const limited = await GET(exportRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('content-disposition')).toBeNull();
    expect(ledger(db)).toHaveLength(5);
  });
});

describe('a member of household A exports household A, as their role reads it', () => {
  it.each(ROLES)('API-BB4FF5888E65 %s: every allowed section of A, nothing of B, and one ledger row in their name', async (role) => {
    const manager = role === 'parent' || role === 'adult';
    const { db, response, raw } = await exportAs(userOf('A', role), { email: `${role}@example.com` });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="bubaly-export-/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const file = JSON.parse(raw) as FamilyExport;
    expect(file.family).toEqual({ id: FAMILY.A, name: 'HOUSEHOLD_A', timezone: 'UTC' });
    expect(file.exportedBy).toEqual({ userId: userOf('A', role), memberId: memberOf('A', role), role });
    expect(file.withheld).toEqual(manager ? [] : ['finances']);

    for (const marker of MARKERS) expect(raw, `A_${marker}`).toContain(`A_${marker}`);
    for (const marker of MANAGER_ONLY_MARKERS) {
      expect(raw.includes(`A_${marker}`), `A_${marker} for ${role}`).toBe(manager);
    }
    // Nothing of the other household, of any kind.
    expect(raw).not.toContain('HOUSEHOLD_B');
    expect(raw).not.toContain(FAMILY.B);
    expect(raw).not.toMatch(/"B_[A-Z_]+/);
    expect(raw).not.toContain('user-B-');
    // Only the caller's own preferences.
    expect(raw).toContain(`A_PREF_${role}`);
    for (const other of ROLES.filter((r) => r !== role)) expect(raw).not.toContain(`A_PREF_${other}`);

    expect(ledger(db)).toHaveLength(1);
    expect(ledger(db)[0]).toMatchObject({
      family_id: FAMILY.A, actor_kind: 'member', actor_id: memberOf('A', role),
      domain: 'privacy', capability: 'export', decision: 'executed',
      context: { role, withheld: manager ? [] : ['finances'] },
    });
  });

  it('API-BB4FF5888E65 a child signed in through the kid login gets the child view, not a manager one', async () => {
    const { response, raw } = await exportAs(userOf('A', 'child'), { email: 'kid-a@kids.bubaly.app' });
    expect(response.status).toBe(200);
    const file = JSON.parse(raw) as FamilyExport;
    expect(file.exportedBy.role).toBe('child');
    expect(file.withheld).toEqual(['finances']);
    expect(raw).not.toContain('A_TRANSACTION');
    expect(raw).not.toContain('A_DOC_SECURE');
  });

  it('API-BB4FF5888E65 a parent of B exports B and nothing of A', async () => {
    const { db, response, raw } = await exportAs(userOf('B', 'parent'));
    expect(response.status).toBe(200);
    for (const marker of [...MARKERS, ...MANAGER_ONLY_MARKERS]) expect(raw).toContain(`B_${marker}`);
    expect(raw).not.toContain('HOUSEHOLD_A');
    expect(raw).not.toMatch(/"A_[A-Z_]+/);
    expect(ledger(db).map((row) => row.family_id)).toEqual([FAMILY.B]);
  });
});

describe('another household’s ids', () => {
  it('API-BB4FF5888E65 a household-B id in the query string is ignored: the file is still A’s', async () => {
    const { db, response, raw } = await exportAs(userOf('A', 'adult'), { query: `?familyId=${FAMILY.B}&family_id=${FAMILY.B}` });
    expect(response.status).toBe(200);
    expect((JSON.parse(raw) as FamilyExport).family.id).toBe(FAMILY.A);
    expect(raw).not.toContain('HOUSEHOLD_B');
    expect(raw).not.toMatch(/"B_[A-Z_]+/);
    expect(ledger(db).map((row) => row.family_id)).toEqual([FAMILY.A]);
  });

  it('API-BB4FF5888E65 an account that is a guest in A and the parent of B, with A active, gets A as a guest and none of B', async () => {
    const { db, response, raw } = await exportAs(DUAL_USER);
    expect(response.status).toBe(200);
    const file = JSON.parse(raw) as FamilyExport;
    expect(file.family.id).toBe(FAMILY.A);
    expect(file.exportedBy).toEqual({ userId: DUAL_USER, memberId: 'member-dual-A', role: 'guest' });
    expect(file.withheld).toEqual(['finances']);
    expect(raw).not.toContain('HOUSEHOLD_B');
    expect(raw).not.toMatch(/"B_[A-Z_]+/);
    expect(raw).not.toContain('A_TRANSACTION');
    expect(ledger(db)).toHaveLength(1);
    expect(ledger(db)[0]).toMatchObject({ family_id: FAMILY.A, actor_id: 'member-dual-A' });
  });
});

describe('a read that fails, and a step-up', () => {
  it('API-BB4FF5888E65 a refused todo read answers 502 naming the section, sends no file, records nothing and leaks no detail', async () => {
    const { db, response, raw } = await exportAs(userOf('A', 'parent'), {
      fault: (table) => (table === 'todo_items' ? { code: 'XX000', message: 'INTERNAL todo_items relation detail' } : null),
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(JSON.parse(raw)).toEqual({ error: 'export_failed', failed: ['todos'], retryable: true });
    expect(raw).not.toContain('INTERNAL');
    expect(ledger(db)).toEqual([]);
  });

  it('API-BB4FF5888E65 a manager who must step up gets 403 with where to go, and nothing is read into a file or recorded', async () => {
    state.assurance = { currentLevel: 'aal1', nextLevel: 'aal2' };
    const { db, response, raw } = await exportAs(userOf('A', 'parent'));
    expect(response.status).toBe(403);
    expect(JSON.parse(raw)).toMatchObject({ error: 'step_up_required' });
    expect(JSON.parse(raw).stepUp).toBe('/auth/step-up?next=%2Fdashboard%2Fsettings%23privacy');
    expect(ledger(db)).toEqual([]);
  });
});
