// GET /api/cron/social-publish over three households, driven through the real
// route, the real cron-auth check, the real drain (lib/social/scheduled-publish.ts),
// the real create action that arms each schedule, the installed supabase-js
// client and the real X adapter. The seams are the ones
// tests/social-scheduled-publish.test.ts already uses: the service client is a
// real supabase-js client whose transport is the in-memory database, and the
// social network is a stubbed global fetch. The drain builds its own service
// client (createServiceClient inside runScheduledPublishDrain), so the mock of
// @/lib/supabase/server is that seam.
//
// Already proven elsewhere (not repeated here):
//   tests/social-scheduled-publish.test.ts — single-family receipt machine: arm,
//     due/not-due, CAS fencing of worker vs manual, approval holds, revoked
//     authority, plan holds (held → 200), reopen holds, provider 400/500 → 503,
//     the five-minute registration and 401 with no header before any request.
//   tests/a-closed-family-is-left-alone-by-the-crons.test.ts — the drain (not the
//     route) inspects only an open family's receipt.
//   tests/a-drain-that-can-be-cancelled-is-given-the-signal.test.ts — the route
//     passes req.signal (source text).
// New here: a wrong secret, two households in one run, a closed household's due
// post through the route, per-household provider credentials and rows, a second
// run, one household's provider failure beside another's success, and an
// unreadable cursor answered as a failure.
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: undefined as unknown as InMemorySupabase,
  service: undefined as unknown as SupabaseClient<Database>,
  serviceCalls: 0,
  userId: '', familyId: '', memberId: '',
  requests: [] as { table: string; method: string }[],
  fault: null as null | { table: string; method: string },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => { state.serviceCalls += 1; return state.service; },
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: state.userId },
  active: { familyId: state.familyId, role: 'parent', member: { id: state.memberId, family_id: state.familyId, user_id: state.userId } },
}) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
vi.mock('next/cache', () => ({ revalidatePath() {} }));

import { createPostAction } from '@/app/(app)/dashboard/social/actions';
import { SCHEDULE_TOOL } from '@/lib/social/scheduled-authority';
import { encryptSecret } from '@/lib/sync/crypto';
import { GET } from '@/app/api/cron/social-publish/route';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const DUE = '2026-09-12T13:00:00.000Z';
const SECRET = 'test-cron-secret-not-real';

type Household = { key: 'A' | 'B' | 'C'; familyId: string; userId: string; memberId: string; body: string; token: string };
const HOUSEHOLDS: Household[] = (['A', 'B', 'C'] as const).map((key, i) => ({
  key,
  familyId: `00000000-0000-4000-8000-0000000000f${i + 1}`,
  userId: `00000000-0000-4000-8000-0000000000e${i + 1}`,
  memberId: `00000000-0000-4000-8000-0000000000d${i + 1}`,
  body: `Household ${key} bake sale on Saturday`,
  token: `synthetic-access-${key}`,
}));
const [A, B, C] = HOUSEHOLDS;

const provider = vi.fn<typeof fetch>();

function primitive(value: string): unknown { return value === 'null' ? null : value === 'true' ? true : value === 'false' ? false : value; }
/** PostgREST over HTTP, answered by the in-memory database (the transport tests/social-scheduled-publish.test.ts uses). */
async function persistenceHttp(raw: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!, method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : null;
  state.requests.push({ table, method });
  if (state.fault?.table === table && state.fault.method === method) {
    state.fault = null;
    return Response.json({ code: '42501', message: 'Synthetic storage unavailable' }, { status: 403 });
  }
  const query = state.db.from(table);
  const prefer = headers.get('prefer') ?? '';
  if (method === 'POST') {
    if (prefer.includes('resolution=merge-duplicates')) query.upsert(body, { onConflict: url.searchParams.get('on_conflict') ?? 'id' });
    else query.insert(body);
  } else if (method === 'PATCH') query.update(body);
  else if (method === 'DELETE') query.delete();
  query.select(url.searchParams.get('select') ?? '*', prefer.includes('count=exact') ? { count: 'exact' } : undefined);
  for (const [key, value] of url.searchParams) {
    if (['select', 'on_conflict', 'columns'].includes(key)) continue;
    if (key === 'limit') { query.limit(Number(value)); continue; }
    if (key === 'order') { for (const order of value.split(',')) { const [column, direction] = order.split('.'); query.order(column, { ascending: direction !== 'desc' }); } continue; }
    const dot = value.indexOf('.'), operator = value.slice(0, dot), expected = value.slice(dot + 1);
    if (operator === 'cs') query.contains(key, JSON.parse(expected));
    // `is` goes through the builder's own method, which reads a filter on an
    // embedded resource (`family.closed_at`) as PostgREST does; `filter` does not.
    else if (operator === 'is') query.is(key, primitive(expected));
    else query.filter(key, operator, primitive(expected));
  }
  const reply = headers.get('accept')?.includes('vnd.pgrst.object') ? await query.single() : await query;
  return Response.json(reply.error ?? reply.data, { status: reply.error ? 409 : method === 'POST' ? 201 : 200,
    headers: reply.count == null ? {} : { 'content-range': `0-0/${reply.count}` } });
}

/** The X request's bearer token and tweet text, as the provider received them. */
function sent(): { token: string; text: string }[] {
  return provider.mock.calls.map(([, init]) => ({
    token: String(new Headers(init?.headers).get('authorization')).replace(/^Bearer /, ''),
    text: (JSON.parse(String(init?.body)) as { text: string }).text,
  }));
}

function signInAs(h: Household): void { state.userId = h.userId; state.familyId = h.familyId; state.memberId = h.memberId; }

function connectX(h: Household): string {
  const id = randomUUID(), providerId = String(5550000 + state.db.table('social_accounts').length), expiresAt = NOW.getTime() + 86_400_000;
  const envelope = { version: 1, accountId: id, familyId: h.familyId, platform: 'x', providerAccountId: providerId,
    accessToken: h.token, refreshToken: '', expiresAt, scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] };
  state.db.seed('social_accounts', [{ id, family_id: h.familyId, platform: 'x', status: 'connected', provider_account_id: providerId, deleted_at: null }]);
  state.db.seed('social_account_tokens', [{ id, account_id: id, family_id: h.familyId, platform: 'x', provider_account_id: providerId,
    access_token_enc: encryptSecret(JSON.stringify(envelope)), expires_at: new Date(expiresAt).toISOString(), metadata: { x_state: 'ready', x_revision: randomUUID() } }]);
  return id;
}

/** The household's parent schedules its post through the real create action. */
async function schedulePost(h: Household): Promise<string> {
  signInAs(h);
  const accountId = connectX(h);
  const fd = new FormData();
  fd.set('intent', 'schedule'); fd.set('kind', 'text'); fd.set('body', h.body);
  fd.set('scheduled_for', DUE); fd.set('timezone', 'UTC'); fd.append('platforms', 'x'); fd.append('account_ids', accountId);
  const result = await createPostAction(fd);
  expect(result).toMatchObject({ ok: true, action: 'schedule' });
  return result.postId!;
}

const receiptOf = (h: Household) => state.db.table('ai_tool_calls')
  .find((r) => r.family_id === h.familyId && r.tool_name === SCHEDULE_TOOL) as Row & { outputs: { phase: string } };
const rowsOf = (table: string, h: Household) => state.db.table(table).filter((r) => r.family_id === h.familyId);

function cron(authorization?: string) {
  return GET(new NextRequest('https://app.example.com/api/cron/social-publish', authorization ? { headers: { authorization } } : undefined));
}
const authorizedCron = () => cron(`Bearer ${SECRET}`);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubEnv('SYNC_TOKEN_KEY', '22'.repeat(32)); vi.stubEnv('X_CLIENT_ID', 'synthetic-client'); vi.stubEnv('X_CLIENT_SECRET', 'synthetic-client-secret-not-real');
  vi.stubEnv('CRON_SECRET', SECRET); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
  state.requests = []; state.fault = null; state.serviceCalls = 0;
  state.db = new InMemorySupabase({ uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], app_settings: [['key']] }, defaults: {
    social_posts: { deleted_at: null, metadata: {}, published_at: null, approval_status: 'not_required' },
    social_post_targets: { provider_object_id: null, metadata: {}, published_at: null, error: null, permalink_url: null },
    social_schedules: { status: 'scheduled', timezone: 'UTC', recurrence: 'none', metadata: {} }, social_calendar_items: { status: 'scheduled', metadata: {} },
    ai_tool_calls: { error: null, locked_at: null, finished_at: null },
  } });
  // The signed-in parent, whichever household is scheduling.
  Object.assign(state.db.auth, { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) });
  for (const h of HOUSEHOLDS) {
    state.db.seed('family_members', [{ id: h.memberId, family_id: h.familyId, user_id: h.userId, role: 'parent', is_active: true }]);
    state.db.seed('families', [{ id: h.familyId, trial_ends_at: null, closed_at: null }]);
    state.db.seed('subscriptions', [{ id: randomUUID(), family_id: h.familyId, plan: 'basic', status: 'active', current_period_end: null }]);
  }
  state.service = createClient<Database>('https://synthetic-storage.invalid', 'synthetic-service-key-not-real', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: persistenceHttp },
  });
  let tweet = 900000000;
  provider.mockReset().mockImplementation(async () => { tweet += 1; return Response.json({ data: { id: String(tweet) } }, { status: 201 }); });
  vi.stubGlobal('fetch', provider);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  for (const h of HOUSEHOLDS) await schedulePost(h);
  // Household C closes its account after scheduling; its post then comes due.
  state.db.table('families').find((f) => f.id === C.familyId)!.closed_at = '2026-09-12T12:30:00.000Z';
  vi.setSystemTime(new Date(DUE));
  state.requests = []; state.serviceCalls = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('GET /api/cron/social-publish is refused without the cron secret', () => {
  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: answers 401 to a request with no Authorization header before any read or provider call', async () => {
    const response = await cron();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false });
    expect(state.serviceCalls).toBe(0);
    expect(state.requests).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: answers 401 to a wrong Bearer secret before any read or provider call', async () => {
    const response = await cron('Bearer not-the-cron-secret');
    expect(response.status).toBe(401);
    expect(state.serviceCalls).toBe(0);
    expect(state.requests).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
    expect(HOUSEHOLDS.map((h) => receiptOf(h).outputs.phase)).toEqual(['queued', 'queued', 'queued']);
  });
});

describe('a run over three households', () => {
  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: sends both open households\' due posts and leaves the closed household\'s post queued and unsent', async () => {
    const response = await authorizedCron();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inspected: 2, attempted: 2, published: 2, pending: 0, unknown: 0, failed: 0, held: 0 });

    expect(provider).toHaveBeenCalledTimes(2);
    for (const h of [A, B]) {
      expect(receiptOf(h).outputs.phase).toBe('completed');
      expect(rowsOf('social_posts', h)).toEqual([expect.objectContaining({ status: 'published', body: h.body })]);
      expect(rowsOf('social_schedules', h).map((r) => r.status)).toEqual(['published']);
      expect(rowsOf('social_calendar_items', h).map((r) => r.status)).toEqual(['published']);
      expect(rowsOf('social_publish_results', h)).toHaveLength(1);
    }
    expect(receiptOf(C).outputs.phase).toBe('queued');
    expect(rowsOf('social_posts', C)).toEqual([expect.objectContaining({ status: 'scheduled' })]);
    expect(rowsOf('social_publish_results', C)).toEqual([]);
  });

  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: each household\'s post goes out with its own account\'s credential, and its rows stay its own', async () => {
    await authorizedCron();
    expect(sent().map((s) => `${s.token}|${s.text}`).sort()).toEqual([`${A.token}|${A.body}`, `${B.token}|${B.body}`]);
    expect(sent().map((s) => s.token)).not.toContain(C.token);
    for (const h of [A, B]) {
      const post = rowsOf('social_posts', h)[0];
      const targets = state.db.table('social_post_targets').filter((t) => t.post_id === post.id);
      expect(targets.map((t) => t.family_id)).toEqual([h.familyId]);
      const accounts = rowsOf('social_accounts', h).map((a) => a.id);
      expect(accounts).toContain(targets[0].account_id);
      expect(state.db.table('social_publish_results').filter((r) => r.post_id === post.id).map((r) => r.family_id)).toEqual([h.familyId]);
    }
  });
});

describe('a second run and a failed run', () => {
  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: a second run sends nothing and writes no new result', async () => {
    await authorizedCron();
    const results = state.db.table('social_publish_results').length;
    const again = await authorizedCron();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, attempted: 0, published: 0, failed: 0 });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(state.db.table('social_publish_results')).toHaveLength(results);
    expect([A, B].map((h) => receiptOf(h).outputs.phase)).toEqual(['completed', 'completed']);
  });

  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: one household\'s provider refusal answers 503 with ok false while the other household\'s post still goes out', async () => {
    const accept = provider.getMockImplementation()!;
    provider.mockImplementation(async (input, init) =>
      new Headers(init?.headers).get('authorization') === `Bearer ${A.token}` ? Response.json({}, { status: 400 }) : accept(input, init));
    const response = await authorizedCron();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, attempted: 2, published: 1, failed: 1 });
    expect(receiptOf(A).outputs.phase).toBe('failed');
    expect(rowsOf('social_posts', A)[0].status).not.toBe('published');
    expect(receiptOf(B).outputs.phase).toBe('completed');
    expect(rowsOf('social_posts', B)[0].status).toBe('published');
  });

  it('API-18FB4D1FF9A8 JOB-3A0C45177B5D: an unreadable drain cursor answers 503 with ok false and sends nothing', async () => {
    state.fault = { table: 'app_settings', method: 'GET' };
    const response = await authorizedCron();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, failed: 1 });
    expect(provider).not.toHaveBeenCalled();
    expect(HOUSEHOLDS.map((h) => receiptOf(h).outputs.phase)).toEqual(['queued', 'queued', 'queued']);
  });
});
