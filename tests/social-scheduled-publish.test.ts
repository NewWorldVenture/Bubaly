import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { SCHEDULES, dueRoutes } from '../scripts/cron-dispatch.mjs';

// Real actions, installed PostgREST builders, private authority, pipeline,
// encrypted token loading and X adapter execute. Only auth/request, persistence
// transport, translation and external HTTP use synthetic fixtures.
const state = vi.hoisted(() => ({ db: undefined as unknown as InMemorySupabase, service: undefined as unknown as SupabaseClient<Database>,
  userId: '11111111-1111-4111-8111-111111111111', familyId: '22222222-2222-4222-8222-222222222222', memberId: '33333333-3333-4333-8333-333333333333',
  requestAuth: true, fault: null as null | { table: string; method: string; at: number; thrown?: boolean; commit?: boolean }, requests: [] as { table: string; method: string; signal: AbortSignal | null | undefined; url: URL; body: Row | null }[],
  beforeRequest: null as null | ((table: string, method: string, body: Row | null) => void),
  hold: null as null | { table: string; at: number; started: () => void },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.service }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  if (!state.requestAuth) throw new Error('Background worker must not request cookies');
  return { user: { id: state.userId }, active: { familyId: state.familyId, role: 'parent',
    member: { id: state.memberId, family_id: state.familyId, user_id: state.userId } } };
} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
vi.mock('next/cache', () => ({ revalidatePath() {} }));
import { createPostAction, retryPublishAction } from '@/app/(app)/dashboard/social/actions';
import { createScheduledPublishReceipt, armScheduledPublishReceipt, runScheduledPublishDrain, publishScheduledPostNow } from '@/lib/social/scheduled-publish';
import { scheduleIdentity, SCHEDULE_TOOL } from '@/lib/social/scheduled-authority';
import { getConnector } from '@/lib/social/connectors';
import { encryptSecret } from '@/lib/sync/crypto';
import { GET } from '@/app/api/cron/social-publish/route';
import { closeAccountAction, reopenAccountAction } from '@/app/(app)/account/actions';

const NOW = new Date('2026-09-12T12:00:00.000Z'), DUE = '2026-09-12T13:00:00.000Z';
const USER = state.userId, MEMBER = state.memberId;
const provider = vi.fn<typeof fetch>();
function primitive(value: string): unknown { return value === 'null' ? null : value === 'true' ? true : value === 'false' ? false : value; }
async function persistenceHttp(raw: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!, method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : null;
  state.requests.push({ table, method, signal: init?.signal, url, body });
  state.beforeRequest?.(table, method, body);
  if (method === 'GET' && state.hold?.table === table && --state.hold.at === 0) {
    const hold = state.hold; state.hold = null; hold.started();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(init?.signal?.reason);
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  let committedError = false;
  if (state.fault?.table === table && state.fault.method === method && --state.fault.at === 0) {
    const fault = state.fault; state.fault = null;
    if (fault.thrown) throw new Error('Synthetic storage unavailable');
    if (!fault.commit) return Response.json({ code: '42501', message: 'Synthetic storage unavailable' }, { status: 403 });
    committedError = true;
  }
  const query = state.db.from(table);
  const prefer = headers.get('prefer') ?? '';
  if (method === 'POST') {
    if (prefer.includes('resolution=merge-duplicates')) query.upsert(body, { onConflict: url.searchParams.get('on_conflict') ?? 'id' });
    else query.insert(body);
  } else if (method === 'PATCH') {
    // The database stamps every update to a family (trg_set_updated_at, 0003).
    if (table === 'families') body.updated_at = new Date().toISOString();
    query.update(body);
  }
  else if (method === 'DELETE') query.delete();
  query.select(url.searchParams.get('select') ?? '*', prefer.includes('count=exact') ? { count: 'exact' } : undefined);
  for (const [key, value] of url.searchParams) {
    if (['select', 'on_conflict', 'columns'].includes(key)) continue;
    if (key === 'limit') { query.limit(Number(value)); continue; }
    if (key === 'order') { for (const order of value.split(',')) { const [column, direction] = order.split('.'); query.order(column, { ascending: direction !== 'desc' }); } continue; }
    const dot = value.indexOf('.'), operator = value.slice(0, dot), expected = value.slice(dot + 1);
    if (operator === 'cs') query.contains(key, JSON.parse(expected));
    else query.filter(key, operator, primitive(expected));
  }
  const reply = headers.get('accept')?.includes('vnd.pgrst.object') ? await query.single() : await query;
  if (committedError) return Response.json({ code: '42501', message: 'Synthetic lost write confirmation' }, { status: 403 });
  return Response.json(reply.error ?? reply.data, { status: reply.error ? 409 : method === 'POST' ? 201 : 200,
    headers: reply.count == null ? {} : { 'content-range': `0-0/${reply.count}` } });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubEnv('SYNC_TOKEN_KEY', '11'.repeat(32)); vi.stubEnv('X_CLIENT_ID', 'synthetic-client'); vi.stubEnv('X_CLIENT_SECRET', 'synthetic-client-secret');
  vi.stubEnv('CRON_SECRET', 'synthetic-cron'); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.invalid');
  state.userId = USER; state.memberId = MEMBER;
  state.requestAuth = true; state.requests = []; state.fault = null; state.beforeRequest = null; state.hold = null;
  state.db = new InMemorySupabase({ userId: state.userId, uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], app_settings: [['key']] }, defaults: {
    social_posts: { deleted_at: null, metadata: {}, published_at: null, approval_status: 'not_required' },
    social_post_targets: { provider_object_id: null, metadata: {}, published_at: null, error: null, permalink_url: null },
    social_schedules: { status: 'scheduled', timezone: 'UTC', recurrence: 'none', metadata: {} }, social_calendar_items: { status: 'scheduled', metadata: {} },
    ai_tool_calls: { error: null, locked_at: null, finished_at: null },
  } });
  state.db.seed('family_members', [{ id: state.memberId, family_id: state.familyId, user_id: state.userId, role: 'parent', is_active: true }]);
  // A family on Family Basic, which Social needs (lib/constants/feature-catalog):
  // the actions and the drain both ask, through the real plan resolver.
  state.db.seed('families', [{ id: state.familyId, trial_ends_at: null, closed_at: null }]);
  state.db.seed('subscriptions', [{ id: randomUUID(), family_id: state.familyId, plan: 'basic', status: 'active', current_period_end: null }]);
  state.service = createClient<Database>('https://synthetic-storage.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: persistenceHttp },
  });
  provider.mockReset().mockImplementation(async () => Response.json({ data: { id: '987654321' } }, { status: 201 }));
  vi.stubGlobal('fetch', provider); vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function account(index = 1) {
  const id = randomUUID(), providerId = String(123456 + index + state.db.table('social_accounts').length), expiresAt = NOW.getTime() + 86_400_000;
  const envelope = { version: 1, accountId: id, familyId: state.familyId, platform: 'x', providerAccountId: providerId,
    accessToken: `synthetic-access-${index}`, refreshToken: '', expiresAt, scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] };
  state.db.seed('social_accounts', [{ id, family_id: state.familyId, platform: 'x', status: 'connected', provider_account_id: providerId, deleted_at: null }]);
  state.db.seed('social_account_tokens', [{ id, account_id: id, family_id: state.familyId, platform: 'x', provider_account_id: providerId,
    access_token_enc: encryptSecret(JSON.stringify(envelope)), expires_at: new Date(expiresAt).toISOString(), metadata: { x_state: 'ready', x_revision: randomUUID() } }]);
  return id;
}
async function schedule(count = 1) {
  const accounts = Array.from({ length: count }, (_, i) => account(i + 1));
  const fd = new FormData(); fd.set('intent', 'schedule'); fd.set('kind', 'text'); fd.set('body', 'Synthetic scheduled post');
  fd.set('scheduled_for', DUE); fd.set('timezone', 'UTC'); fd.append('platforms', 'x'); accounts.forEach(id => fd.append('account_ids', id));
  const result = await createPostAction(fd);
  expect(result).toMatchObject({ ok: true, action: 'schedule' });
  return result.postId!;
}
function receipt() { return state.db.table('ai_tool_calls')[0] as Row & { inputs: Row; outputs: Row & { phase: string; targets: Row[] } }; }
async function due() { vi.setSystemTime(new Date(DUE)); return runScheduledPublishDrain(); }

describe('scheduled X publishing through the installed SDK and private authority', () => {
  it('arms from the real action, waits for the absolute instant, and dispatches without request cookies', async () => {
    const postId = await schedule();
    expect(receipt()).toMatchObject({ actor_kind: 'system', requested_by: null, run_id: null, inputs: { actor: { userId: state.userId, memberId: state.memberId } }, outputs: { phase: 'queued' } });
    expect(JSON.stringify(receipt())).not.toContain('synthetic-access');
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0 }); expect(provider).not.toHaveBeenCalled();
    state.requestAuth = false;
    expect(await due()).toMatchObject({ attempted: 1, failed: 0 });
    expect(provider).toHaveBeenCalledOnce(); expect(receipt().outputs.phase).toBe('completed');
    expect(state.db.table('social_posts')[0]).toMatchObject({ id: postId, status: 'published', metadata: { schedule_timezone: 'UTC', schedule_phase: 'completed' } });
    expect(state.db.table('social_schedules')[0].status).toBe('published'); expect(state.db.table('social_calendar_items')[0].status).toBe('published');
    expect(state.requests.filter(request => request.table.startsWith('social_') && ['POST', 'PATCH'].includes(request.method)).every(request => request.signal instanceof AbortSignal)).toBe(true);
    expect(new URL(String(provider.mock.calls[0][0])).href).toBe('https://api.x.com/2/tweets');
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0 }); expect(provider).toHaveBeenCalledOnce();
  });
  it('dispatches the bounded ten-account selection and retains each private confirmation', async () => {
    await schedule(10); await due(); expect(provider).toHaveBeenCalledTimes(10);
    expect(receipt().outputs.targets.every(target => target.phase === 'published')).toBe(true);
    expect(state.db.table('social_publish_results')).toHaveLength(10);
  });
  it('manual publish now and a later cron share the receipt and reconcile schedule/calendar', async () => {
    const postId = await schedule(); const result = await retryPublishAction(postId);
    expect(result).toMatchObject({ ok: true, outcome: { status: 'published' } });
    expect(state.db.table('social_schedules')[0].status).toBe('published'); await due(); expect(provider).toHaveBeenCalledOnce();
  });
  it('serializes a manual/cron race before the first provider request', async () => {
    const postId = await schedule(); vi.setSystemTime(new Date(DUE));
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    provider.mockImplementationOnce(async () => { entered(); await waiting; return Response.json({ data: { id: '987654321' } }, { status: 201 }); });
    const worker = runScheduledPublishDrain(); await started;
    expect(await publishScheduledPostNow(postId)).toMatchObject({ status: 'publishing' });
    release(); await worker; expect(provider).toHaveBeenCalledOnce();
  });
  it('CAS-fences simultaneous worker and manual starts which both read queued authority', async () => {
    const postId = await schedule(); vi.setSystemTime(new Date(DUE));
    await Promise.allSettled([runScheduledPublishDrain(), publishScheduledPostNow(postId), runScheduledPublishDrain()]);
    expect(provider).toHaveBeenCalledOnce(); expect(receipt().outputs.phase).toBe('completed');
  });
  it('records a fresh legitimate manual actor instead of reusing a public or historical author', async () => {
    const postId = await schedule(); state.userId = randomUUID(); state.memberId = randomUUID();
    state.db.seed('family_members', [{ id: state.memberId, user_id: state.userId, family_id: state.familyId, role: 'adult', is_active: true }]);
    expect(await publishScheduledPostNow(postId)).toMatchObject({ status: 'published' });
    expect(receipt().inputs.actor).toEqual({ userId: USER, memberId: MEMBER });
    expect(receipt().outputs.actor).toEqual({ userId: state.userId, memberId: state.memberId });
  });
  it.each(['require_approval', 'pending', 'approved', 'rejected', 'changes_requested'])('holds unverified approval authority: %s', async mode => {
    if (mode === 'require_approval') state.db.seed('social_settings', [{ family_id: state.familyId, require_approval: true }]);
    const postId = await schedule();
    if (mode !== 'require_approval') state.db.table('social_posts')[0].approval_status = mode;
    await due(); expect(provider).not.toHaveBeenCalled(); expect(receipt().outputs.phase).toBe('approval_required');
    await expect(publishScheduledPostNow(postId)).rejects.toThrow('socialSchedule.approvalRequired');
  });
  it.each(['inactive', 'permission', 'member-read', 'permission-read', 'setting-read'])('fails closed when current actor authority changes: %s', async mode => {
    await schedule();
    if (mode === 'inactive') state.db.table('family_members')[0].is_active = false;
    if (mode === 'permission') state.db.seed('social_access_permissions', [{ family_id: state.familyId, user_id: state.userId, status: 'active', social_role: 'read_only' }]);
    if (mode.endsWith('-read')) state.fault = { table: mode === 'member-read' ? 'family_members' : mode === 'permission-read' ? 'social_access_permissions' : 'social_settings', method: 'GET', at: 1 };
    expect(await due()).toMatchObject({ failed: 1 }); expect(provider).not.toHaveBeenCalled();
  });
  it('shows a transient required-read failure and clears it only after a successful later execution', async () => {
    await schedule(); state.fault = { table: 'family_members', method: 'GET', at: 1 };
    await due(); expect(receipt().outputs).toMatchObject({ phase: 'queued', errorKey: 'socialSchedule.accessUnavailable' });
    expect(state.db.table('social_posts')[0].metadata).toMatchObject({ schedule_error: 'socialSchedule.accessUnavailable' });
    await runScheduledPublishDrain(); expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('social_posts')[0].metadata).toMatchObject({ schedule_phase: 'completed', schedule_error: null });
  });
  it('shows revoked authority as held failure and never labels an unsent schedule publishing', async () => {
    await schedule(); state.db.table('family_members')[0].is_active = false; await due();
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.permissionDenied' });
    expect(state.db.table('social_schedules')[0]).toMatchObject({ status: 'failed', metadata: { schedule_error: 'socialSchedule.permissionDenied' } });
    await runScheduledPublishDrain(); expect(provider).not.toHaveBeenCalled();
  });
  it.each(['body', 'variant', 'link', 'time', 'target', 'provider', 'disconnect'])('does not dispatch a changed immutable snapshot: %s', async mode => {
    await schedule();
    if (mode === 'body') state.db.table('social_posts')[0].body = 'changed';
    if (mode === 'variant') state.db.table('social_post_variants')[0].body = 'changed';
    if (mode === 'link') state.db.table('social_posts')[0].link = 'https://changed.invalid';
    if (mode === 'time') state.db.table('social_schedules')[0].scheduled_for = '2026-09-12T14:00:00Z';
    if (mode === 'target') state.db.table('social_post_targets')[0].account_id = account(2);
    if (mode === 'provider') state.db.table('social_accounts')[0].provider_account_id = '987654';
    if (mode === 'disconnect') state.db.table('social_accounts')[0].status = 'disconnected';
    expect(await due()).toMatchObject({ failed: 1 }); expect(provider).not.toHaveBeenCalled();
  });
  it('uses the private initiator after public created_by/user_id tampering', async () => {
    await schedule(); state.db.table('social_posts')[0].created_by = randomUUID(); state.db.table('social_posts')[0].user_id = randomUUID();
    await due(); expect(provider).toHaveBeenCalledOnce();
    expect(receipt().outputs.actor).toEqual({ userId: state.userId, memberId: state.memberId });
  });
  it.each(['network', '408', '500', 'malformed'])('retains an ambiguous %s outcome across age, worker and manual retry', async mode => {
    const postId = await schedule();
    if (mode === 'network') provider.mockRejectedValueOnce(new DOMException('Synthetic timeout', 'TimeoutError'));
    if (mode === '500') provider.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    if (mode === '408') provider.mockResolvedValueOnce(Response.json({}, { status: 408 }));
    if (mode === 'malformed') provider.mockResolvedValueOnce(Response.json({}, { status: 201 }));
    expect(await due()).toMatchObject({ attempted: 1, unknown: 1, published: 0 }); expect(receipt().outputs.phase).toBe('unknown');
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z')); await runScheduledPublishDrain();
    expect(await publishScheduledPostNow(postId)).toMatchObject({ status: 'publishing' }); expect(provider).toHaveBeenCalledOnce();
  });
  it('retries only a confirmed 429 and never repeats an earlier confirmed target', async () => {
    await schedule(2); provider.mockResolvedValueOnce(Response.json({ data: { id: '987654321' } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({}, { status: 429 }));
    expect(await due()).toMatchObject({ pending: 1, published: 0 }); expect(receipt().outputs.phase).toBe('queued'); expect(provider).toHaveBeenCalledTimes(2);
    await runScheduledPublishDrain(); expect(provider).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-09-12T13:05:01Z')); await runScheduledPublishDrain();
    expect(provider).toHaveBeenCalledTimes(3); expect(receipt().outputs.phase).toBe('completed');
  });
  it('does not automatically retry a different confirmed rejection alongside a rate-limited target', async () => {
    await schedule(2); provider.mockResolvedValueOnce(Response.json({}, { status: 400 })).mockResolvedValueOnce(Response.json({}, { status: 429 }));
    await due(); expect(provider).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-09-12T13:05:01Z')); await runScheduledPublishDrain();
    expect(provider).toHaveBeenCalledTimes(3); expect(receipt().outputs.phase).toBe('failed');
    expect(receipt().outputs.targets.map(target => target.phase).sort()).toEqual(['failed', 'published']);
  });
  it('holds a provider acceptance whose private confirmation write fails', async () => {
    const postId = await schedule();
    provider.mockImplementationOnce(async () => { state.fault = { table: 'ai_tool_calls', method: 'PATCH', at: 1 }; return Response.json({ data: { id: '987654321' } }, { status: 201 }); });
    await due(); expect(['unknown', 'dispatching']).toContain(receipt().outputs.phase);
    await runScheduledPublishDrain(); await publishScheduledPostNow(postId); expect(provider).toHaveBeenCalledOnce();
  });
  it('never reclaims a private provider confirmation applied before its HTTP response was lost', async () => {
    const postId = await schedule();
    provider.mockImplementationOnce(async () => { state.fault = { table: 'ai_tool_calls', method: 'PATCH', at: 1, commit: true }; return Response.json({ data: { id: '987654321' } }, { status: 201 }); });
    await due(); expect(receipt().outputs.phase).toBe('dispatching'); expect(receipt().outputs.targets[0].phase).toBe('published');
    state.db.table('social_posts')[0].metadata = { schedule_timezone: 'UTC' };
    state.db.table('social_calendar_items')[0].metadata = { schedule_timezone: 'UTC' };
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z')); await runScheduledPublishDrain();
    expect(state.db.table('social_posts')[0].metadata).toMatchObject({ schedule_phase: 'dispatching', schedule_error: 'socialSchedule.awaitingConfirmation' });
    expect(state.db.table('social_calendar_items')[0].status).toBe('publishing');
    expect(await publishScheduledPostNow(postId)).toMatchObject({ status: 'publishing' }); expect(provider).toHaveBeenCalledOnce();
  });
  it('repairs public outcome failure from durable private confirmation without reposting', async () => {
    const postId = await schedule(); state.fault = { table: 'social_publish_results', method: 'POST', at: 1 };
    await due(); expect(receipt().outputs.phase).toBe('completed');
    expect(state.db.table('social_post_targets')[0]).toMatchObject({ status: 'published', provider_object_id: '987654321' });
    expect(state.db.table('social_posts')[0].status).toBe('published');
    expect(state.db.table('social_posts')[0].published_at).toBe(DUE);
    expect(state.db.table('social_post_targets')[0].published_at).toBe(DUE);
    await publishScheduledPostNow(postId); expect(provider).toHaveBeenCalledOnce();
  });
  it.each(['social_accounts', 'social_account_tokens'])('aborts a held installed-SDK %s token read without GET retries or provider sends', async table => {
    await schedule(); vi.setSystemTime(new Date(DUE));
    const controller = new AbortController(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    state.beforeRequest = (name, method, body) => {
      const outputs = body?.outputs as { targets?: Row[] } | undefined;
      if (name === 'ai_tool_calls' && method === 'PATCH' && outputs?.targets?.some(target => target.phase === 'dispatching')) {
        // authorizeScheduledToken checks the snapshot account first; hold the
        // later credential read, after receipt/membership/snapshot authority.
        state.hold = { table, at: table === 'social_accounts' ? 2 : 1, started: entered }; state.beforeRequest = null;
      }
    };
    const worker = runScheduledPublishDrain({ signal: controller.signal }); await started;
    const count = state.requests.filter(request => request.table === table && request.method === 'GET').length;
    controller.abort(new DOMException('Synthetic outer deadline', 'TimeoutError')); await worker;
    expect(provider).not.toHaveBeenCalled();
    expect(state.requests.filter(request => request.table === table && request.method === 'GET')).toHaveLength(count);
    const held = state.requests.filter(request => request.table === table && request.method === 'GET').at(-1)!;
    expect(held.signal?.reason.name).toBe('AbortError');
  });
  it('rechecks membership at private-token access after the target claim', async () => {
    await schedule();
    state.beforeRequest = (table, method, body) => {
      const outputs = body?.outputs as { targets?: Row[] } | undefined;
      if (table === 'ai_tool_calls' && method === 'PATCH' && outputs?.targets?.some(target => target.phase === 'dispatching')) {
        state.db.table('family_members')[0].is_active = false; state.beforeRequest = null;
      }
    };
    await due(); expect(provider).not.toHaveBeenCalled(); expect(receipt().outputs.targets[0].phase).toBe('failed');
  });
  it('rechecks authority before every target after an earlier provider confirmation', async () => {
    await schedule(2); provider.mockImplementationOnce(async () => {
      state.db.table('family_members')[0].is_active = false; return Response.json({ data: { id: '987654321' } }, { status: 201 });
    });
    expect(await due()).toMatchObject({ failed: 1 }); expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('social_schedules')[0].status).toBe('partially_published');
    expect(receipt().outputs.targets.map(target => target.phase).sort()).toEqual(['failed', 'published']);
  });
  it.each(['expired', 'blocked', 'ambiguous'])('rechecks %s credentials at dispatch after valid enqueue', async mode => {
    await schedule();
    if (mode === 'expired') state.db.table('social_account_tokens')[0].expires_at = NOW.toISOString();
    if (mode === 'blocked') state.db.table('social_account_tokens')[0].metadata = { x_state: 'blocked' };
    if (mode === 'ambiguous') state.db.seed('social_account_tokens', [{ ...state.db.table('social_account_tokens')[0], id: randomUUID() }]);
    expect(await due()).toMatchObject({ failed: 1 }); expect(provider).not.toHaveBeenCalled();
  });
  it.each(['actor_kind', 'requested_by', 'family_id', 'resource_id'])('rejects a corrupted private %s binding before any provider call', async key => {
    await schedule(); receipt()[key] = key === 'actor_kind' ? 'member' : randomUUID();
    expect(await due()).toMatchObject({ failed: 1 }); expect(provider).not.toHaveBeenCalled();
  });
  it('advances the durable cursor past future receipts so a later due receipt is not starved', async () => {
    for (let i = 0; i < 22; i++) await schedule();
    const receipts = [...state.db.table('ai_tool_calls')].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const row of receipts.slice(0, -1)) {
      const inputs = row.inputs as Row, later = '2026-09-12T14:00:00.000Z'; inputs.scheduledFor = later;
      for (const table of ['social_posts', 'social_schedules', 'social_post_targets', 'social_calendar_items']) {
        for (const publicRow of state.db.table(table)) if (publicRow.post_id === inputs.postId || publicRow.id === inputs.postId) publicRow.scheduled_for = later;
      }
    }
    expect(await due()).toMatchObject({ inspected: 20, attempted: 0 });
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 1, published: 1 }); expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('app_settings')[0].key).toBe(`${SCHEDULE_TOOL}:cursor`);
  });
  it('rejects a forged scheduled claim through the actual registered X connector', async () => {
    const postId = await schedule(); const target = state.db.table('social_post_targets')[0], acct = state.db.table('social_accounts')[0];
    const result = await getConnector('x').publish({ platform: 'x', kind: 'text', familyId: state.familyId, userId: state.userId,
      accountId: String(target.account_id), providerAccountId: String(acct.provider_account_id), body: 'Synthetic scheduled post', mediaUrls: [],
      scheduledClaim: { receiptId: scheduleIdentity(state.familyId, postId).id, revision: randomUUID(), targetId: String(target.id) } });
    expect(result.status).toBe('failed'); expect(provider).not.toHaveBeenCalled();
  });
  it('does not auto-publish an old public-only schedule with no private receipt', async () => {
    await schedule(); state.db.replace('ai_tool_calls', []); await due(); expect(provider).not.toHaveBeenCalled();
  });
  it('checks private reservation before arming and preserves an uncertain arm identity', async () => {
    const postId = await schedule(); const row = receipt(); row.outputs.phase = 'unarmed'; row.outputs.drain = false;
    const saved = await createScheduledPublishReceipt({ familyId: state.familyId, postId, scheduleId: String(row.inputs.scheduleId), scheduledFor: DUE, timezone: 'UTC',
      expected: { kind: 'text', body: 'Synthetic scheduled post', link: null, accountIds: state.db.table('social_accounts').map(account => String(account.id)) } });
    state.fault = { table: 'ai_tool_calls', method: 'PATCH', at: 1 };
    await expect(armScheduledPublishReceipt(saved.receiptId)).rejects.toThrow('socialSchedule.storageUnavailable');
    expect(receipt().outputs.phase).toBe('unarmed'); expect(provider).not.toHaveBeenCalled();
  });
  it('the real create action retains the same post after an arm write committed with a lost response', async () => {
    const accountId = account(); state.fault = { table: 'ai_tool_calls', method: 'PATCH', at: 1, commit: true };
    const fd = new FormData(); fd.set('intent', 'schedule'); fd.set('kind', 'text'); fd.set('body', 'Synthetic scheduled post');
    fd.set('scheduled_for', DUE); fd.set('timezone', 'UTC'); fd.append('platforms', 'x'); fd.append('account_ids', accountId);
    const result = await createPostAction(fd);
    expect(result).toMatchObject({ ok: false, action: 'schedule', postId: expect.any(String) });
    expect(receipt().outputs.phase).toBe('queued'); expect(state.db.table('social_posts')).toHaveLength(1);
    await due(); expect(provider).toHaveBeenCalledOnce(); expect(state.db.table('social_posts')[0].id).toBe(result.postId);
  });
  it.each(['ambiguous-token', 'expired-token', 'blocked-token'])('checks %s at enqueue without arming or sending', async mode => {
    const accountId = account();
    if (mode === 'ambiguous-token') state.db.seed('social_account_tokens', [{ ...state.db.table('social_account_tokens')[0], id: randomUUID() }]);
    if (mode === 'expired-token') state.db.table('social_account_tokens')[0].expires_at = NOW.toISOString();
    if (mode === 'blocked-token') state.db.table('social_account_tokens')[0].metadata = { x_state: 'blocked' };
    const fd = new FormData(); fd.set('intent', 'schedule'); fd.set('kind', 'text'); fd.set('body', 'Synthetic scheduled post');
    fd.set('scheduled_for', DUE); fd.set('timezone', 'UTC'); fd.append('platforms', 'x'); fd.append('account_ids', accountId);
    expect(await createPostAction(fd)).toMatchObject({ ok: false, error: 'socialSchedule.reconnectRequired' });
    expect(state.db.table('ai_tool_calls')).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it('tightening the setting between two arm calls can only move queued authority to held', async () => {
    await schedule(); state.db.seed('social_settings', [{ family_id: state.familyId, require_approval: true }]);
    expect(await armScheduledPublishReceipt(String(receipt().id))).toEqual({ phase: 'approval_required' });
    state.db.table('social_settings')[0].require_approval = false;
    expect(await armScheduledPublishReceipt(String(receipt().id))).toEqual({ phase: 'approval_required' });
    await due(); expect(provider).not.toHaveBeenCalled();
  });
  it('registers the protected five-minute worker and rejects unauthenticated cron before reads', async () => {
    expect(SCHEDULES['/api/cron/social-publish']).toBe('*/5 * * * *'); expect(dueRoutes(NOW)).toContain('/api/cron/social-publish');
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')); expect(config.crons.some((cron: { path: string }) => cron.path === '/api/cron/social-publish')).toBe(true);
    expect((await GET(new NextRequest('https://app.invalid/api/cron/social-publish'))).status).toBe(401); expect(state.requests).toHaveLength(0);
    const response = await GET(new NextRequest('https://app.invalid/api/cron/social-publish', { headers: { authorization: 'Bearer synthetic-cron' } }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, attempted: 0 });
    expect(SCHEDULE_TOOL).toBe('social.scheduled_publish');
  });
  // household-roles N2: the drain published for every family with a queued
  // post, so a family that dropped below Social's tier (or every family, once
  // Social was switched off) still had its scheduled posts sent.
  //
  // N2-R2: such a post was then left queued, and went out on the first tick
  // after the family was entitled again, however late, with nobody asked. It
  // is now held when it comes due, with the reason, like revoked authority.
  it.each([
    ['dropped to Free', () => { state.db.table('subscriptions')[0].status = 'canceled'; }],
    ['Social switched off', () => { state.db.seed('app_settings', [{ key: 'feature_tiers', value: { 'social-circle': 'off' } }]); }],
  ] as const)('holds a family\'s post that comes due once it is %s, unsent and with the reason', async (_case, lose) => {
    await schedule();
    lose();
    state.requestAuth = false;
    // N2-R2-CRON: a hold for the plan is the family's choice, not a fault.
    expect(await due()).toMatchObject({ attempted: 0, published: 0, failed: 0, held: 1 });
    expect(provider).not.toHaveBeenCalled();
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.notInPlan' });
    expect(state.db.table('social_posts')[0]).toMatchObject({ status: 'scheduled', metadata: { schedule_phase: 'failed', schedule_error: 'socialSchedule.notInPlan' } });
    expect(state.db.table('social_schedules')[0]).toMatchObject({ status: 'failed', metadata: { schedule_error: 'socialSchedule.notInPlan' } });
  });
  it('a post not yet due is left queued while the family is without Social, and sent on time once it has Social again (control)', async () => {
    await schedule();
    state.db.table('subscriptions')[0].status = 'canceled';
    state.requestAuth = false;
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, failed: 0 });
    expect(receipt().outputs).toMatchObject({ phase: 'queued', errorKey: null });
    state.db.table('subscriptions')[0].status = 'active';
    expect(await due()).toMatchObject({ attempted: 1, published: 1 }); expect(provider).toHaveBeenCalledOnce();
  });
  it('a family that may use Social again is not sent a post that came due without it; whoever may publish sends it by hand', async () => {
    const postId = await schedule();
    state.db.table('subscriptions')[0].status = 'canceled';
    expect(await due()).toMatchObject({ attempted: 0 }); expect(provider).not.toHaveBeenCalled();
    state.db.table('subscriptions')[0].status = 'active';
    // Later the same day (within the synthetic X token's life).
    vi.setSystemTime(new Date(Date.parse(DUE) + 6 * 3_600_000));
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, published: 0 }); expect(provider).not.toHaveBeenCalled();
    expect(receipt().outputs.phase).toBe('failed');
    expect(await retryPublishAction(postId)).toMatchObject({ ok: true, outcome: { status: 'published' } });
    expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('social_posts')[0].status).toBe('published');
  });
  // household-roles N2-R2-CRON, round 3: the hold above was counted as a
  // drain failure, so the route answered 503 and the dispatcher marked the run
  // failed every time a post came due after a downgrade.
  const cron = () => GET(new NextRequest('https://app.invalid/api/cron/social-publish', { headers: { authorization: 'Bearer synthetic-cron' } }));
  it('a post held because the family dropped to Free leaves the cron green and is reported as held', async () => {
    await schedule();
    state.db.table('subscriptions')[0].status = 'canceled';
    vi.setSystemTime(new Date(DUE));
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, attempted: 0, published: 0, failed: 0, held: 1 });
    expect(provider).not.toHaveBeenCalled();
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.notInPlan' });
  });
  it('a post held because its author lost the authority still turns the cron red (control)', async () => {
    await schedule();
    state.db.table('family_members')[0].is_active = false;
    vi.setSystemTime(new Date(DUE));
    const response = await cron();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, failed: 1 });
    expect(body.held ?? 0).toBe(0);
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.permissionDenied' });
  });
  // household-roles N2-R2-CLOSED, round 3: the drain reads open families only,
  // so a closed family's posts stayed queued, and the first tick after it
  // reopened sent every one that came due while it was closed, however late.
  // The real close and reopen actions, then the drain: held like a downgrade.
  /** A parent with no authenticator enrolled: closing and reopening ask for no code. */
  function signedInAsAParent() {
    Object.assign(state.db.auth, {
      getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    });
  }
  it('a family that reopens is not sent a post that came due while it was closed; whoever may publish sends it by hand', async () => {
    const postId = await schedule();
    signedInAsAParent();
    expect(await closeAccountAction()).toEqual({ ok: true });
    // No cron looks at a closed family (tests/a-closed-family-is-left-alone-by-the-crons.test.ts),
    // so the post passes its time queued. Reopened three hours after it, with Basic still active.
    expect(receipt().outputs).toMatchObject({ phase: 'queued' });
    vi.setSystemTime(new Date(Date.parse(DUE) + 3 * 3_600_000));
    state.requestAuth = true;
    expect(await reopenAccountAction()).toEqual({ ok: true });
    state.requestAuth = false;
    expect(await runScheduledPublishDrain()).toMatchObject({ inspected: 1, attempted: 0, published: 0, failed: 0, held: 1 });
    expect(provider).not.toHaveBeenCalled();
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.cameDueWhileClosed' });
    expect(state.db.table('social_posts')[0]).toMatchObject({ status: 'scheduled', metadata: { schedule_phase: 'failed', schedule_error: 'socialSchedule.cameDueWhileClosed' } });
    expect(state.db.table('social_schedules')[0]).toMatchObject({ status: 'failed', metadata: { schedule_error: 'socialSchedule.cameDueWhileClosed' } });
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, published: 0 }); expect(provider).not.toHaveBeenCalled();
    state.requestAuth = true;
    expect(await retryPublishAction(postId)).toMatchObject({ ok: true, outcome: { status: 'published' } });
    expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('social_posts')[0].status).toBe('published');
  });
  it('a post due after the family reopened goes out at its time (control)', async () => {
    await schedule();
    signedInAsAParent();
    expect(await closeAccountAction()).toEqual({ ok: true });
    vi.setSystemTime(new Date(Date.parse(DUE) - 30 * 60_000));
    expect(await reopenAccountAction()).toEqual({ ok: true });
    state.requestAuth = false;
    expect(await due()).toMatchObject({ attempted: 1, published: 1, failed: 0 });
    expect(provider).toHaveBeenCalledOnce();
    expect(receipt().outputs.phase).toBe('completed');
  });
  // household-roles N3-R1-CLOSED-FALSE-HOLD, round 4: round 3 held a post that
  // came due before families.updated_at, and the database stamps that on EVERY
  // change to the row: a rename, the address, the time zone, the cover,
  // onboarding. So an OPEN family that edited its profile after a post came
  // due, before the drain reached it (the drain takes 20 receipts a run, so
  // that can be hours), had the post held as "came due while closed", where
  // main sends it. The hold now asks the reopen itself: reopenAccountAction
  // records it in the family's audit trail, and a post is held only when that
  // record is later than the time it came due.
  /** A parent renames the family (components/modules/settings-module.tsx sends this); the database stamps updated_at. */
  async function renameTheFamily() {
    const renamed = await state.service.from('families').update({ name: 'The Riveras' }).eq('id', state.familyId).select('id, updated_at');
    expect(renamed.error).toBeNull();
    expect(renamed.data).toHaveLength(1);
    return renamed.data![0].updated_at;
  }
  it.each([
    ['a minute after it came due, and the drain a minute later', 60_000, 2 * 60_000],
    ['two hours after it came due, and the drain an hour after that', 2 * 3_600_000, 3 * 3_600_000],
  ])('an open family that edits its profile %s has the post sent, not held', async (_when, editedAfter, drainedAfter) => {
    await schedule();
    state.requestAuth = false;
    vi.setSystemTime(new Date(Date.parse(DUE) + editedAfter));
    expect(Date.parse(await renameTheFamily())).toBeGreaterThan(Date.parse(DUE));
    vi.setSystemTime(new Date(Date.parse(DUE) + drainedAfter));
    expect(await runScheduledPublishDrain()).toMatchObject({ inspected: 1, attempted: 1, published: 1, failed: 0, held: 0 });
    expect(provider).toHaveBeenCalledOnce();
    expect(receipt().outputs).toMatchObject({ phase: 'completed', errorKey: null });
  });
  it('a family that reopened before the post came due, and edits its profile after, has it sent', async () => {
    await schedule();
    signedInAsAParent();
    expect(await closeAccountAction()).toEqual({ ok: true });
    vi.setSystemTime(new Date(Date.parse(DUE) - 30 * 60_000));
    expect(await reopenAccountAction()).toEqual({ ok: true });
    state.requestAuth = false;
    vi.setSystemTime(new Date(Date.parse(DUE) + 60_000));
    await renameTheFamily();
    vi.setSystemTime(new Date(Date.parse(DUE) + 2 * 60_000));
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 1, published: 1, failed: 0, held: 0 });
    expect(provider).toHaveBeenCalledOnce();
  });
  it('the reopen is what is recorded: once, by the parent who reopened, with the close it ended', async () => {
    await schedule();
    signedInAsAParent();
    expect(await closeAccountAction()).toEqual({ ok: true });
    const closedAt = state.db.table('families')[0].closed_at;
    expect(state.db.table('audit_logs')).toEqual([]);
    vi.setSystemTime(new Date(Date.parse(DUE) + 3 * 3_600_000));
    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(state.db.table('audit_logs')).toEqual([expect.objectContaining({
      family_id: state.familyId, actor_id: USER, action: 'update', resource: 'family', resource_id: state.familyId,
      metadata: { change: 'reopened', closed_at: closedAt }, created_at: new Date(Date.parse(DUE) + 3 * 3_600_000).toISOString(),
    })]);
    // A reopen of a family that is open already (a stale gate in another tab) reopens nothing and records nothing.
    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(state.db.table('audit_logs')).toHaveLength(1);
    // And a rename after the reopen does not move it: the post is still held for the reopen it waited through.
    await renameTheFamily();
    state.requestAuth = false;
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, published: 0, held: 1 });
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.cameDueWhileClosed' });
    expect(provider).not.toHaveBeenCalled();
  });
  it('when the reopen record cannot be read, the post is neither sent nor held: it stays queued for the next tick', async () => {
    await schedule();
    signedInAsAParent();
    expect(await closeAccountAction()).toEqual({ ok: true });
    vi.setSystemTime(new Date(Date.parse(DUE) + 3 * 3_600_000));
    expect(await reopenAccountAction()).toEqual({ ok: true });
    state.requestAuth = false;
    state.fault = { table: 'audit_logs', method: 'GET', at: 1 };
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, published: 0, failed: 1, held: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(receipt().outputs).toMatchObject({ phase: 'queued', errorKey: 'socialSchedule.storageUnavailable' });
    expect(await runScheduledPublishDrain()).toMatchObject({ attempted: 0, held: 1 });
    expect(receipt().outputs).toMatchObject({ phase: 'failed', errorKey: 'socialSchedule.cameDueWhileClosed' });
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([400, 500])('reports an unsuccessful provider HTTP%s attempt through the actual cron', async status => {
    await schedule(); vi.setSystemTime(new Date(DUE)); provider.mockResolvedValueOnce(Response.json({}, { status }));
    const response = await GET(new NextRequest('https://app.invalid/api/cron/social-publish', { headers: { authorization: 'Bearer synthetic-cron' } }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, attempted: 1, published: 0,
      ...(status === 400 ? { failed: 1 } : { unknown: 1 }) });
    expect(provider).toHaveBeenCalledOnce();
  });
});
