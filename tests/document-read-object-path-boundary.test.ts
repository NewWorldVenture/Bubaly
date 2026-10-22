// Actual services, registry and executor port, through the installed SDK.
// The sealed transport supplies synthetic database/signing replies; it does
// not establish live Storage authorization, SQL policy installation or Auth.
import { appendFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { readDocument } from '@/lib/services/documents';
import { createExecutorPort, type RunSnapshot } from '@/lib/ai/runs/executor';
import { isReservedDocumentPath } from '@/lib/storage/documents';

const server = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No synthetic service client');
    return server.client;
  },
}));

const ORIGIN = 'https://document-signing.invalid';
const FAMILY = 'a1b2c3d4-e5f6-4789-8abc-1234567890ab';
const OTHER = 'b1b2c3d4-e5f6-4789-8abc-1234567890ab';
const USER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const PLAN = '66666666-6666-4666-8666-666666666666';
const STEP = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-16T16:00:00Z');
const OWN = `${FAMILY}/general/manual.pdf`;
const GROUPED = 'a1b2-c3d4-e5f6-4789-8abc-1234-5678-90ab';
type Call = { rawUrl: string; url: string; method: string; table: string | null; query: Record<string, string>; body?: Record<string, unknown> };
type Options = {
  role?: ServiceScope['role'];
  sensitive?: boolean;
  missing?: boolean;
  metadataError?: boolean;
  storageError?: boolean;
  inactive?: boolean;
};
type Observation = { path: unknown; calls: Call[]; errors: string[]; results: unknown[] };
let observations: Observation[];

function fixture(path: unknown, options: Options = {}) {
  const observation: Observation = { path, calls: [], errors: [], results: [] };
  observations.push(observation);
  const { calls, errors, results } = observation;
  const doc = {
    id: DOCUMENT, family_id: FAMILY, title: options.sensitive ? 'Private legal title' : 'School calendar',
    category: options.sensitive ? 'legal' : 'school', is_secure: false, storage_path: path,
    mime_type: 'application/pdf', size_bytes: 123, expires_at: null, member_id: null, asset_id: null,
    is_favorite: false, created_by: USER, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  const transport: typeof fetch = async (input, init) => {
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin !== ORIGIN || calls.length >= 20) throw new Error('Unexpected destination or unbounded request');
      expect(req.headers.get('authorization')).toBe('Bearer synthetic-service-only');
      const table = url.pathname.startsWith('/rest/v1/') ? url.pathname.slice('/rest/v1/'.length) : null;
      const body = req.method === 'POST' ? await req.json() as Record<string, unknown> : undefined;
      calls.push({ rawUrl, url: req.url, method: req.method, table, query: Object.fromEntries(url.searchParams), body });
      if (table && req.method === 'GET') {
        if (table === 'families') {
          expect(url.searchParams.get('id')).toBe(`eq.${FAMILY}`);
          return Response.json([{ id: FAMILY, timezone: 'UTC' }]);
        }
        expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
        if (table === 'documents') {
          expect(url.searchParams.get('id')).toBe(`eq.${DOCUMENT}`);
          if (options.metadataError) return Response.json({ code: '42501', message: 'Synthetic metadata refused' }, { status: 403 });
          return Response.json(options.missing ? [] : [doc]);
        }
        if (table === 'family_members') {
          expect(url.searchParams.get('id')).toBe(`eq.${MEMBER}`);
          return Response.json([{ id: MEMBER, family_id: FAMILY, user_id: USER, role: options.role ?? 'parent', is_active: !options.inactive }]);
        }
        if (table === 'ai_plans') {
          expect(url.searchParams.get('id')).toBe(`eq.${PLAN}`);
          return Response.json([{ id: PLAN, family_id: FAMILY, request_id: REQUEST }]);
        }
        if (table === 'ai_requests') {
          expect(url.searchParams.get('id')).toBe(`eq.${REQUEST}`);
          return Response.json([{ id: REQUEST, family_id: FAMILY, requested_by_member_id: MEMBER, kind: 'concierge' }]);
        }
        if (['family_ai_settings', 'trust_policies', 'permission_grants', 'trust_delegations', 'emergency_sessions'].includes(table)) return Response.json([]);
      }
      if (req.method === 'POST' && table === 'agent_activity') {
        expect(body).toMatchObject({ family_id: FAMILY, created_by: USER, agent: 'documents' });
        return Response.json({ id: 'activity-id' }, { status: 201 });
      }
      if (req.method === 'POST' && table === 'trust_audit_logs') {
        expect(body).toMatchObject({ family_id: FAMILY, domain: 'documents', capability: 'view' });
        return new Response(null, { status: 201 });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/storage/v1/object/sign/documents/')) {
        expect(body).toHaveProperty('expiresIn');
        if (options.storageError) return Response.json({ statusCode: '403', error: 'Forbidden', message: 'Synthetic Storage refusal' }, { status: 403 });
        // A deliberately permissive signer models the privileged caller. It
        // is not evidence that any real object exists or Storage would sign it.
        return Response.json({ signedURL: `/object/sign/documents/synthetic-receipt?token=synthetic-only` });
      }
      throw new Error(`Unexpected request: ${req.method} ${url.pathname}`);
    } catch (error) {
      errors.push(String(error));
      throw error;
    }
  };
  const db = createClient<Database>(ORIGIN, 'synthetic-service-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => null, global: { fetch: transport },
  });
  server.client = db;
  const scope: ServiceScope = {
    db, familyId: FAMILY, userId: USER, memberId: MEMBER, role: options.role ?? 'parent',
    actorKind: 'ai', tz: 'UTC', now: NOW,
  };
  const capture = async <T,>(pending: Promise<T>): Promise<T> => {
    try { const result = await pending; results.push(result); return result; }
    catch (error) { results.push({ threw: String(error) }); throw error; }
  };
  const direct = (expiresInSeconds?: number) => capture(readDocument(scope, DOCUMENT, { expiresInSeconds }));
  const viaExecutor = async () => {
    const port = createExecutorPort(db);
    const run: RunSnapshot = {
      id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST,
      requested_by_member_id: MEMBER, state: 'executing', cancel_requested_at: null, paused_at: null,
      attempt: 1, max_attempts: 3, lease_owner: 'synthetic-worker',
    };
    const scoped = await port.scopeFor(run);
    if (!scoped.ok) { results.push(scoped); return { status: 'scope_refused' as const, result: scoped }; }
    expect(scoped.data.db).toBe(db);
    expect(scoped.data).toMatchObject({ familyId: FAMILY, userId: USER, memberId: MEMBER, role: options.role ?? 'parent', actorKind: 'ai' });
    return capture(port.runTool(scoped.data, 'documents.readDocument', { document_id: DOCUMENT }, {
      runId: RUN, stepId: STEP, requestId: REQUEST, idempotencyKey: 'synthetic-read', skipTrust: false,
    }));
  };
  return {
    db, calls, errors, direct, viaExecutor,
    signed: () => calls.filter(call => new URL(call.url).pathname.startsWith('/storage/')),
    activity: () => calls.filter(call => call.table === 'agent_activity'),
  };
}

function didNotSign(h: ReturnType<typeof fixture>) {
  expect(h.signed()).toEqual([]);
  expect(h.activity()).toEqual([]);
  expect(h.errors).toEqual([]);
}

beforeEach(() => {
  observations = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture cannot use a provider or external network'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach((context) => {
  const destination = process.env.DOCUMENT_PATH_OBSERVATIONS;
  if (destination) appendFileSync(destination, JSON.stringify({ name: context.task.name, observations }) + '\n');
  for (const observation of observations) expect(observation.errors).toEqual([]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const UNSAFE: { label: string; path: unknown }[] = [
  { label: 'another family', path: `${OTHER}/general/private.pdf` },
  { label: 'another family UUID alias', path: `{${OTHER.toUpperCase()}}/private.pdf` },
  { label: 'family prefix lookalike', path: `${FAMILY}0/general/private.pdf` },
  { label: 'root traversal', path: `${FAMILY}/../${OTHER}/private.pdf` },
  { label: 'nested traversal', path: `${FAMILY}/general/../../${OTHER}/private.pdf` },
  { label: 'encoded dot traversal', path: `${FAMILY}/%2e%2e/${OTHER}/private.pdf` },
  { label: 'encoded slash', path: `${FAMILY}%2f..%2f${OTHER}/private.pdf` },
  { label: 'double encoded dot', path: `${FAMILY}/%252e%252e/private.pdf` },
  { label: 'backslash traversal', path: `${FAMILY}\\..\\${OTHER}/private.pdf` },
  { label: 'query', path: `${OWN}?alternate=private` },
  { label: 'fragment', path: `${OWN}#private` },
  { label: 'control newline', path: `${FAMILY}/general/priva\nte.pdf` },
  { label: 'control NUL', path: `${FAMILY}/general/private\u0000.pdf` },
  { label: 'empty segment', path: `${FAMILY}//private.pdf` },
  { label: 'dot segment', path: `${FAMILY}/./private.pdf` },
  { label: 'trailing slash', path: `${FAMILY}/general/` },
  { label: 'absolute URL', path: `https://foreign.invalid/${OTHER}/private.pdf` },
  { label: 'leading slash', path: `/${FAMILY}/private.pdf` },
  { label: 'terminal space', path: `${OWN} ` },
  { label: 'terminal dot and space', path: `${FAMILY}/general/.. ` },
  { label: 'UUID with unmatched brace', path: `{${FAMILY}/private.pdf` },
  { label: 'UUID with invalid grouping', path: `${FAMILY.slice(0, 3)}-${FAMILY.slice(3)}/private.pdf` },
  { label: 'empty path', path: '' },
  { label: 'null path', path: null },
  { label: 'non-string path', path: 123 },
];

describe('a service-role document read binds the object to the metadata family', () => {
  it.each(UNSAFE)('refuses $label before signing or recording an opened document', async ({ path }) => {
    const h = fixture(path);
    expect(await h.direct()).toMatchObject({ ok: false });
    expect(h.calls.filter(call => call.table === 'documents')).toHaveLength(1);
    didNotSign(h);
  });

  it.each([
    ['canonical', OWN],
    ['direct family file', `${FAMILY}/manual.pdf`],
    ['nested historical folder', `${FAMILY}/manuals/asset-one/history/manual.pdf`],
    ['embedded spaces and Unicode', `${FAMILY}/School Records/校历 résumé.pdf`],
    ['uppercase UUID', `${FAMILY.toUpperCase()}/general/manual.pdf`],
    ['braced UUID', `{${FAMILY}}/general/manual.pdf`],
    ['compact UUID', `${FAMILY.replaceAll('-', '')}/general/manual.pdf`],
    ['four-digit grouping', `${GROUPED}/general/manual.pdf`],
    ['braced uppercase compact UUID', `{${FAMILY.replaceAll('-', '').toUpperCase()}}/manual.pdf`],
  ])('preserves the exact raw object name for %s', async (_name, path) => {
    const h = fixture(path);
    expect(await h.direct()).toMatchObject({ ok: true, data: { document: { id: DOCUMENT }, expiresAt: '2026-10-16T16:02:00.000Z' } });
    expect(h.signed()).toHaveLength(1);
    expect(h.signed()[0]).toMatchObject({ rawUrl: `${ORIGIN}/storage/v1/object/sign/documents/${path}`, body: { expiresIn: 120 } });
    expect(decodeURIComponent(new URL(h.signed()[0].url).pathname.slice('/storage/v1/object/sign/documents/'.length))).toBe(path);
    expect(h.activity()).toHaveLength(1);
    expect(h.activity()[0].body?.title).toBe('Opened "School calendar"');
  });

  it.each(['teen', 'child', 'caregiver', 'guest', 'system'] as const)('keeps a sensitive document unavailable to %s', async role => {
    const h = fixture(OWN, { role, sensitive: true });
    expect(await h.direct()).toMatchObject({ ok: false, code: 'denied' });
    didNotSign(h);
  });

  it('keeps the ordinary-document teen service control', async () => {
    const h = fixture(OWN, { role: 'teen' });
    expect(await h.direct()).toMatchObject({ ok: true });
    expect(h.signed()).toHaveLength(1);
  });

  it('keeps sensitive titles off the family-readable opened-document feed', async () => {
    const h = fixture(OWN, { sensitive: true });
    expect(await h.direct()).toMatchObject({ ok: true, data: { document: { sensitive: true } } });
    expect(h.activity()[0].body?.title).toBe('Opened a private document');
    expect(JSON.stringify(h.activity())).not.toContain('Private legal title');
  });

  it('does not sign a missing metadata row', async () => {
    const h = fixture(OWN, { missing: true });
    expect(await h.direct()).toMatchObject({ ok: false, code: 'not_found' });
    didNotSign(h);
  });

  it('preserves a refused metadata read before any signing', async () => {
    const h = fixture(OWN, { metadataError: true });
    expect(await h.direct()).toMatchObject({ ok: false, code: 'db' });
    didNotSign(h);
  });

  it('preserves a Storage refusal without opened-document activity', async () => {
    const h = fixture(OWN, { storageError: true });
    expect(await h.direct()).toMatchObject({ ok: false, code: 'db' });
    expect(h.signed()).toHaveLength(1);
    expect(h.activity()).toEqual([]);
  });

  it.each([[1, 30], [120.6, 121], [999999, 900]])('keeps the existing TTL clamp for %s', async (requested, sent) => {
    const h = fixture(OWN);
    expect(await h.direct(requested)).toMatchObject({ ok: true });
    expect(h.signed()[0].body?.expiresIn).toBe(sent);
  });
});

describe('the real executor port revalidates the requester and dispatches the registered read', () => {
  it('refuses another family object despite a valid parent run and same-family metadata', async () => {
    const h = fixture(`${OTHER}/private.pdf`);
    expect(await h.viaExecutor()).toMatchObject({ status: 'error' });
    expect(h.calls.filter(call => call.table === 'documents')).toHaveLength(1);
    expect(h.calls.some(call => call.table === 'family_members')).toBe(true);
    expect(h.calls.some(call => call.table === 'ai_requests')).toBe(true);
    didNotSign(h);
  });

  it('preserves a healthy parent run and returns its short-lived signed link', async () => {
    const h = fixture(OWN);
    expect(await h.viaExecutor()).toMatchObject({ status: 'ok', data: { document: { id: DOCUMENT }, expires_at: '2026-10-16T16:02:00.000Z' } });
    expect(h.signed()).toHaveLength(1);
    expect(h.activity()).toHaveLength(1);
  });

  it('retains the teen documents gate before any document lookup', async () => {
    const h = fixture(OWN, { role: 'teen' });
    expect(await h.viaExecutor()).toMatchObject({ status: 'denied' });
    expect(h.calls.some(call => call.table === 'documents')).toBe(false);
    didNotSign(h);
  });

  it('retains revoked-requester refusal before the registry runs', async () => {
    const h = fixture(OWN, { inactive: true });
    expect(await h.viaExecutor()).toMatchObject({ status: 'scope_refused', result: { ok: false, code: 'denied' } });
    expect(h.calls.some(call => call.table === 'documents' || call.table === 'trust_policies')).toBe(false);
    didNotSign(h);
  });
});

describe('upload reservations retain exact family and folder identity', () => {
  it('continues to accept the exact nested reservation and reject another folder', () => {
    expect(isReservedDocumentPath(FAMILY, 'legal', `${FAMILY}/legal/reservation/document.pdf`)).toBe(true);
    expect(isReservedDocumentPath(FAMILY, 'legal', `${FAMILY}/school/reservation/document.pdf`)).toBe(false);
  });

  it('does not reinterpret UUID aliases as the same exact upload reservation', () => {
    expect(isReservedDocumentPath(FAMILY, 'legal', `{${FAMILY}}/legal/document.pdf`)).toBe(false);
    expect(isReservedDocumentPath(FAMILY, 'legal', `${FAMILY.toUpperCase()}/legal/document.pdf`)).toBe(false);
  });
});
