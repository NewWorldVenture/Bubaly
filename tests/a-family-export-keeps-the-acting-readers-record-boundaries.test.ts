// Actual GET -> ServiceScope -> services -> streamed serializer, with an
// already-resolved actor and a synthetic transport under the installed SDK.
// This does not authenticate a cookie, execute native RLS, or test Claude's
// active localized-document/calendar fixes. Those dependencies stay read-only:
// documents use only canonical is_secure flags; calendar/school rows are empty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MemberRole } from '@/lib/constants/roles';
import type { UserContext } from '@/lib/supabase/auth';
import type { FamilyExport } from '@/lib/privacy/export';

const seam = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), rate: vi.fn(), assurance: vi.fn(), ledger: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({
  getUserContext: seam.context,
  requireUserContext: () => { throw new Error('Unexpected AuthV2 reentry in synthetic export fixture'); },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.server }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: seam.rate }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: seam.assurance }));
vi.mock('@/lib/trust/ledger', () => ({ ledgerWriter: seam.ledger }));

const { GET } = await import('@/app/api/privacy/export/route');
type Row = Record<string, unknown>;
type Actor = { family: 'A' | 'B'; role: 'parent' | 'adult' | 'child' | 'guest' };
type Read = { table: string; method: string; params: Record<string, string>; status: number };
const ORIGIN = 'http://127.0.0.1:9';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const familyId = (actor: Actor) => `synthetic-family-${actor.family}`;
const userId = (actor: Actor) => `synthetic-user-${actor.family}-${actor.role}`;
const memberId = (actor: Actor) => `synthetic-member-${actor.family}-${actor.role}`;
const manager = (actor: Actor) => actor.role === 'parent' || actor.role === 'adult';
const preference = (actor: Actor) => `${actor.family}_PREFERENCE_${actor.role}`;
const actors: Actor[] = [
  { family: 'A', role: 'parent' }, { family: 'A', role: 'adult' },
  { family: 'A', role: 'child' }, { family: 'A', role: 'guest' },
  { family: 'B', role: 'parent' }, { family: 'B', role: 'guest' },
];

function seededRows(): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {
    families: [], family_members: [], user_preferences: [], family_facts: [],
    family_playbook_suggestions: [], documents: [], calendar_events: [], todo_items: [],
    vacations: [], grocery_lists: [], school_events: [], school_classes: [],
    sports_events: [], teams: [], family_automation_rules: [], transactions: [],
  };
  for (const family of ['A', 'B'] as const) {
    const id = familyId({ family, role: 'parent' });
    tables.families.push({ id, name: `EXPORT_FAMILY_${family}`, timezone: 'America/New_York' });
    tables.family_members.push({
      id: `${id}-removed`, family_id: id, user_id: `${family}_REMOVED_AUTH_USER`,
      display_name: `${family}_MEMBER_REMOVED`, role: 'adult', is_active: false,
      birthday: '1980-01-02', avatar_url: `${family}_REMOVED_AVATAR`, color: 'blue', created_at: '2026-01-01T00:00:00Z',
    });
    tables.family_facts.push(
      { id: `${family}-fact-public`, family_id: id, category: 'preference', label: `${family}_MEMORY_PUBLIC`, value: 'likes green', notes: null, is_pinned: false, updated_at: NOW.toISOString() },
      { id: `${family}-fact-private`, family_id: id, category: 'medical', label: `${family}_MEMORY_PRIVATE`, value: `${family}_FACT_VALUE_PRIVATE`, notes: `${family}_FACT_NOTES_PRIVATE`, is_pinned: false, updated_at: NOW.toISOString() },
    );
    tables.family_playbook_suggestions.push(
      { id: `${family}-pending-public`, family_id: id, status: 'suggested', category: 'preference', label: `${family}_PENDING_PUBLIC`, value: 'likes muffins', evidence: 'The family said so', confidence: 0.8 },
      { id: `${family}-pending-private`, family_id: id, status: 'suggested', category: 'about', label: `${family}_PENDING_PRIVATE`, value: `${family}_PENDING_VALUE_PRIVATE`, evidence: `bank account ${family}_PENDING_EVIDENCE_PRIVATE`, confidence: 0.9 },
    );
    for (const secure of [false, true]) tables.documents.push({
      id: `${family}-document-${secure ? 'private' : 'public'}`, family_id: id,
      title: `${family}_DOCUMENT_${secure ? 'PRIVATE' : 'PUBLIC'}`, category: 'school',
      is_secure: secure, storage_path: `${id}/${family}_STORAGE_${secure ? 'PRIVATE' : 'PUBLIC'}`,
      mime_type: 'application/pdf', size_bytes: 20, expires_at: null, member_id: null, asset_id: null,
      created_at: NOW.toISOString(),
    });
  }
  for (const actor of actors) {
    tables.family_members.push({
      id: memberId(actor), family_id: familyId(actor), user_id: userId(actor),
      display_name: `${actor.family}_MEMBER_${actor.role}`, role: actor.role, is_active: true,
      birthday: null, avatar_url: null, color: 'teal', created_at: '2026-02-01T00:00:00Z',
    });
    tables.user_preferences.push({ user_id: userId(actor), theme: 'dark', push_enabled: true,
      email_enabled: true, notification_prefs: { fixture_marker: preference(actor) } });
  }
  return tables;
}

function actorContext(actor: Actor, rows: Record<string, Row[]>): UserContext {
  // Explicit resolved-context seam, not proof that authentication produced it.
  const family = rows.families.find((row) => row.id === familyId(actor)) as UserContext['active']['family'];
  const member = rows.family_members.find((row) => row.id === memberId(actor)) as UserContext['active']['member'];
  const active = { familyId: familyId(actor), family, member, role: actor.role as MemberRole };
  return { user: { id: userId(actor), email: `${actor.role}-${actor.family}@example.invalid` }, memberships: [active], active };
}

function transportFor(actor: Actor, failFacts = false) {
  const rows = seededRows(), reads: Read[] = [], writes: Row[] = [], violations: string[] = [];
  const allowedKeys = new Set(['select', 'order', 'limit', 'offset', 'or', 'family_id', 'id', 'user_id',
    'is_active', 'status', 'starts_at', 'date', 'recurrence', 'recurrence_until', 'schedule_kind', 'is_archived', 'archived_at']);
  const headTables = new Set(['family_facts', 'family_playbook_suggestions', 'documents', 'calendar_events', 'school_events', 'sports_events', 'transactions']);
  const fetcher: typeof fetch = async (input, init) => {
    try {
      const request = new Request(input, init), url = new URL(request.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toMatch(/^\/rest\/v1\/[a-z_]+$/);
      const table = url.pathname.slice('/rest/v1/'.length), method = request.method;
      if (table === 'trust_audit_logs') {
        expect(method).toBe('POST');
        const body: unknown = await request.json();
        expect(body).not.toBeNull();
        expect(Array.isArray(body)).toBe(false);
        expect(body).toMatchObject({ family_id: familyId(actor), actor_kind: 'member', actor_id: memberId(actor),
          domain: 'privacy', capability: 'export', decision: 'executed' });
        expect(Object.keys(body as Row).sort()).toEqual(['actor_id', 'actor_kind', 'capability', 'context', 'decision', 'domain', 'family_id', 'reason']);
        expect((body as { context: Row }).context.role).toBe(actor.role);
        writes.push(body as Row);
        return new Response(null, { status: 201 });
      }
      expect(Object.hasOwn(rows, table), `Unknown table ${table}`).toBe(true);
      expect(['GET', 'HEAD']).toContain(method);
      if (method === 'HEAD') {
        expect(headTables.has(table)).toBe(true);
        expect(request.headers.get('prefer')).toContain('count=exact');
        expect(url.searchParams.get('select')).toBe('id');
      }
      for (const key of url.searchParams.keys()) expect(allowedKeys.has(key), `Unknown query key ${key}`).toBe(true);
      const params = Object.fromEntries(url.searchParams.entries());
      expect(params.select).toBeTruthy();
      if (table === 'families') expect(params.id).toBe(`eq.${familyId(actor)}`);
      else if (table === 'user_preferences') {
        expect(params.user_id).toBe(`eq.${userId(actor)}`);
        expect(params.family_id).toBeUndefined();
        expect(params.select).toBe('theme,push_enabled,email_enabled,notification_prefs');
      } else expect(params.family_id).toBe(`eq.${familyId(actor)}`);
      if (table === 'family_members') expect(params.is_active).toBe(manager(actor) ? undefined : 'eq.true');
      if (table === 'family_playbook_suggestions') expect(params.status).toBe('eq.suggested');
      if (method === 'GET' && table === 'family_facts') expect(params.limit).toBe('500');
      if (method === 'GET' && table === 'family_playbook_suggestions') expect(params.limit).toBe('200');
      if (method === 'GET' && table === 'documents') expect(params.limit).toBe('500');
      if (table === 'transactions') expect(manager(actor)).toBe(true);
      let selected = rows[table];
      for (const [key, raw] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
        const match = /^(not\.is|eq|neq|is|gte|lte|gt|lt)\.(.*)$/.exec(raw);
        expect(match, `Unknown filter ${key}=${raw}`).not.toBeNull();
        if (!match) throw new Error('Unsupported filter');
        const [, op, text] = match;
        const value = text === 'true' ? true : text === 'false' ? false : text === 'null' ? null : text;
        selected = selected.filter((row) => {
          if (op === 'eq' || op === 'is') return row[key] === value;
          if (op === 'neq' || op === 'not.is') return row[key] !== value;
          if (op === 'gte') return String(row[key]) >= text;
          if (op === 'lte') return String(row[key]) <= text;
          if (op === 'gt') return String(row[key]) > text;
          return String(row[key]) < text;
        });
      }
      // OR belongs only to empty date-window sections here. Never ignore an OR
      // on seeded visibility rows, which could otherwise manufacture a pass.
      if (params.or) expect(['calendar_events', 'school_events', 'sports_events', 'transactions']).toContain(table);
      if (['calendar_events', 'school_events', 'school_classes', 'sports_events'].includes(table)) expect(selected).toEqual([]);
      const status = failFacts && table === 'family_facts' && method === 'GET' ? 500 : 200;
      reads.push({ table, method, params, status });
      if (status === 500) return new Response(JSON.stringify({ code: 'SYNTHETIC_READ_REFUSAL', message: 'Synthetic memory read refused' }), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      const count = selected.length;
      const headers = { 'Content-Type': 'application/json', 'Content-Range': `*/${count}` };
      if (method === 'HEAD') return new Response(null, { status, headers });
      const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? selected.length);
      selected = selected.slice(offset, offset + limit);
      if (params.select !== '*') selected = selected.map((row) => Object.fromEntries(params.select.split(',').map((key) => [key, row[key]])));
      const body = request.headers.get('accept')?.includes('application/vnd.pgrst.object+json') ? selected[0] ?? null : selected;
      return new Response(JSON.stringify(body), { status, headers });
    } catch (error) {
      // The SDK may turn fetch failures into a ServiceResult. The explicit
      // zero-violation oracle below therefore applies even to the 502 control.
      violations.push(error instanceof Error ? error.message : String(error));
      return new Response(JSON.stringify({ code: 'UNEXPECTED_SYNTHETIC_QUERY', message: 'Fixture query rejected' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  };
  const client = createClient<Database>(ORIGIN, 'synthetic-publishable-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
  return { rows, reads, writes, violations, client };
}

async function invoke(actor: Actor, failFacts = false) {
  const h = transportFor(actor, failFacts), context = actorContext(actor, h.rows);
  seam.context.mockReset().mockResolvedValue(context);
  seam.server.mockReset().mockResolvedValue(h.client);
  seam.rate.mockReset().mockResolvedValue({ ok: true });
  seam.assurance.mockReset().mockResolvedValue({ action: 'allow' });
  seam.ledger.mockReset().mockResolvedValue(h.client);
  const response = await GET(new NextRequest('https://export.example.invalid/api/privacy/export', {
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'application/json' },
  }));
  const raw = await response.text();
  expect(response.bodyUsed).toBe(true);
  expect(h.violations).toEqual([]);
  expect(seam.context).toHaveBeenCalledTimes(1);
  expect(seam.server).toHaveBeenCalledTimes(1);
  expect(seam.rate).toHaveBeenCalledExactlyOnceWith(h.client, `privacy-export:${userId(actor)}`, { limit: 5 });
  expect(seam.assurance).toHaveBeenCalledExactlyOnceWith(context, 'documents', '/dashboard/settings#privacy');
  return { ...h, response, raw, parsed: JSON.parse(raw) as FamilyExport };
}

function assertSuccessfulView(result: Awaited<ReturnType<typeof invoke>>, actor: Actor) {
  const { response, raw, parsed, reads, writes } = result;
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="bubaly-export-/);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(parsed.format).toBe('bubaly-family-export');
  expect(parsed.family.id).toBe(familyId(actor));
  expect(parsed.exportedBy).toEqual({ userId: userId(actor), memberId: memberId(actor), role: actor.role });
  const sections = Object.fromEntries(parsed.sections.map((section) => [section.key, section]));
  const memories = sections.memories.data as { facts: Row[]; pending: Row[] };
  expect(memories.facts.map((row) => row.label)).toContain(`${actor.family}_MEMORY_PUBLIC`);
  expect(memories.pending.map((row) => row.label)).toContain(`${actor.family}_PENDING_PUBLIC`);
  expect((sections.documents.data as Row[]).map((row) => row.title)).toContain(`${actor.family}_DOCUMENT_PUBLIC`);
  expect(sections.memories.count).toBe(manager(actor) ? 2 : 1);
  expect(memories.pending).toHaveLength(manager(actor) ? 2 : 1);
  expect(sections.documents.count).toBe(manager(actor) ? 2 : 1);
  expect(sections.members.includesRemovedMembers).toBe(manager(actor));
  const members = sections.members.data as { id: string; userId: string | null; displayName: string; role: MemberRole; isActive: boolean }[];
  const activeIds = actors.filter((candidate) => candidate.family === actor.family).map(memberId);
  const visibleIds = [...activeIds, ...(manager(actor) ? [`${familyId(actor)}-removed`] : [])];
  expect(members.map((row) => row.id).sort()).toEqual(visibleIds.sort());
  expect(members.filter((row) => row.isActive).map((row) => row.id).sort()).toEqual(activeIds.sort());
  expect(members.find((row) => row.id === memberId(actor))).toMatchObject({
    id: memberId(actor), userId: userId(actor), displayName: `${actor.family}_MEMBER_${actor.role}`,
    role: actor.role, isActive: true,
  });
  expect(members).toHaveLength(visibleIds.length);
  expect(sections.members.count).toBe(visibleIds.length);
  expect(raw).toContain(preference(actor));
  for (const other of actors.filter((candidate) => userId(candidate) !== userId(actor))) expect(raw).not.toContain(preference(other));
  const foreign = actor.family === 'A' ? 'B' : 'A';
  expect(raw).not.toContain(`EXPORT_FAMILY_${foreign}`);
  expect(raw).not.toContain(`synthetic-family-${foreign}`);
  expect(raw).not.toContain(`synthetic-user-${foreign}-`);
  for (const marker of ['MEMORY_PUBLIC', 'MEMORY_PRIVATE', 'PENDING_PUBLIC', 'PENDING_PRIVATE', 'DOCUMENT_PUBLIC', 'DOCUMENT_PRIVATE', 'MEMBER_REMOVED']) {
    expect(raw).not.toContain(`${foreign}_${marker}`);
  }
  for (const family of ['A', 'B']) for (const sensitivity of ['PUBLIC', 'PRIVATE']) expect(raw).not.toContain(`${family}_STORAGE_${sensitivity}`);
  for (const marker of ['MEMORY_PRIVATE', 'FACT_VALUE_PRIVATE', 'FACT_NOTES_PRIVATE', 'PENDING_PRIVATE', 'PENDING_VALUE_PRIVATE', 'PENDING_EVIDENCE_PRIVATE', 'DOCUMENT_PRIVATE', 'MEMBER_REMOVED', 'REMOVED_AUTH_USER', 'REMOVED_AVATAR']) {
    if (manager(actor)) expect(raw).toContain(`${actor.family}_${marker}`);
    else expect(raw).not.toContain(`${actor.family}_${marker}`);
  }
  expect(parsed.withheld).toEqual(manager(actor) ? [] : ['finances']);
  expect(parsed.sections.some((section) => section.key === 'finances')).toBe(manager(actor));
  expect(reads.some((read) => read.table === 'transactions')).toBe(manager(actor));
  for (const table of ['family_facts', 'family_playbook_suggestions', 'documents']) {
    expect(reads.filter((read) => read.table === table && read.method === 'HEAD')).toHaveLength(1);
    expect(reads.filter((read) => read.table === table && read.method === 'GET')).toHaveLength(1);
  }
  expect(seam.ledger).toHaveBeenCalledExactlyOnceWith(result.client);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ family_id: familyId(actor), actor_kind: 'member', actor_id: memberId(actor), domain: 'privacy', capability: 'export', decision: 'executed' });
  expect(writes[0].context).toMatchObject({ role: actor.role, sections: Object.fromEntries(parsed.sections.map((section) => [section.key, section.count])), withheld: parsed.withheld });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('a family export keeps the acting reader’s record boundaries', () => {
  it('a parent keeps allowed A records and only that user’s preferences in the attachment and audit', async () => {
    const actor = { family: 'A', role: 'parent' } as const;
    assertSuccessfulView(await invoke(actor), actor);
  });
  it('an adult keeps manager records without becoming a parent or another preference owner', async () => {
    const actor = { family: 'A', role: 'adult' } as const;
    assertSuccessfulView(await invoke(actor), actor);
  });
  it('a child keeps ordinary facts and suggestions while private records and removed members stay out', async () => {
    const actor = { family: 'A', role: 'child' } as const;
    assertSuccessfulView(await invoke(actor), actor);
  });
  it('a guest keeps ordinary records with only that guest’s preferences and actor identity', async () => {
    const actor = { family: 'A', role: 'guest' } as const;
    assertSuccessfulView(await invoke(actor), actor);
  });
  it('a coherent B caller after an A caller receives only B records and its own audit', async () => {
    const actorA = { family: 'A', role: 'parent' } as const;
    const first = await invoke(actorA);
    assertSuccessfulView(first, actorA);
    const actorB = { family: 'B', role: 'guest' } as const;
    const second = await invoke(actorB);
    assertSuccessfulView(second, actorB);
    expect([...first.writes, ...second.writes].map((row) => [row.family_id, row.actor_id])).toEqual([
      [familyId(actorA), memberId(actorA)], [familyId(actorB), memberId(actorB)],
    ]);
  });
  it('a sensitive-section read failure refuses the whole attachment before any executed-download audit', async () => {
    const result = await invoke({ family: 'A', role: 'parent' }, true);
    expect(result.response.status).toBe(502);
    expect(result.response.headers.get('content-disposition')).toBeNull();
    expect(result.parsed).toEqual({ error: 'export_failed', failed: ['memories'], retryable: true });
    expect(result.raw).not.toContain('bubaly-family-export');
    expect(result.raw).not.toContain('A_MEMORY');
    expect(result.raw).not.toContain('A_DOCUMENT');
    expect(result.reads.filter((read) => read.status === 500)).toEqual([
      expect.objectContaining({ table: 'family_facts', method: 'GET', status: 500 }),
    ]);
    expect(seam.ledger).not.toHaveBeenCalled();
    expect(result.writes).toEqual([]);
  });
});
