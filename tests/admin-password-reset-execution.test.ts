import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';

const state = vi.hoisted(() => ({
  client: undefined as unknown as SupabaseClient<Database>, allowed: vi.fn(), user: vi.fn(), factory: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: state.allowed, getUser: state.user }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: state.factory }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://reset-fixture.invalid', sendReactEmail: vi.fn() }));
vi.mock('@/lib/stripe/settings', () => ({}));
vi.mock('@/lib/stripe', () => ({}));
import { adminSendPasswordResetAction } from '@/app/(app)/admin/actions';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const AUDIT = '22222222-2222-4222-8222-222222222222';
const requests: Array<{ url: URL; method: string; body: unknown; signal?: AbortSignal | null }> = [];
let providerStatus = 200, providerThrow = false, malformedProvider = false;
let auditStatus = 201, auditThrow = false, auditHeld = false, auditRows: unknown = [{ id: AUDIT }];

beforeEach(() => {
  requests.length = 0; providerStatus = 200; providerThrow = false; malformedProvider = false;
  auditStatus = 201; auditThrow = false; auditHeld = false; auditRows = [{ id: AUDIT }];
  state.allowed.mockReset().mockResolvedValue(true);
  state.user.mockReset().mockResolvedValue({ id: ACTOR });
  state.factory.mockReset().mockImplementation(() => state.client);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.client = createClient<Database>('https://reset-provider-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw));
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, signal: init.signal });
      if (url.pathname === '/auth/v1/recover') {
        if (providerThrow) throw new Error('Synthetic connection lost after possible acceptance');
        if (malformedProvider) return new Response('malformed-json', { status: 200, headers: { 'content-type': 'application/json' } });
        return Response.json(providerStatus === 200 ? {} : { code: 'synthetic_failure', msg: 'Synthetic provider rejection' }, { status: providerStatus });
      }
      if (url.pathname === '/rest/v1/audit_logs') {
        if (auditHeld) return new Promise((_resolve, reject) => {
          const abort = () => reject(init.signal?.reason);
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
        });
        if (auditThrow) throw new Error('Synthetic audit transport failure');
        return Response.json(auditStatus === 201 ? auditRows : { code: '42501', message: 'Synthetic audit denial' }, { status: auditStatus });
      }
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    } },
  });
});
afterEach(() => { vi.restoreAllMocks(); });
const providerCalls = () => requests.filter(request => request.url.pathname === '/auth/v1/recover');
const auditCalls = () => requests.filter(request => request.url.pathname === '/rest/v1/audit_logs');

describe('actual reset action through installed Auth/PostgREST SDK', () => {
  it('keeps confirmed provider acceptance after the later audit actor read throws', async () => {
    state.user.mockRejectedValue(new Error('Synthetic actor read outage'));
    await expect(adminSendPasswordResetAction('target@example.invalid')).resolves.toMatchObject({ ok: true, outcome: 'accepted', audit: 'unconfirmed' });
    expect(providerCalls()).toHaveLength(1); expect(auditCalls()).toEqual([]);
  });
  it.each(['returned-error', 'throw', 'missing-actor'])('keeps provider acceptance with a visible audit warning after %s', async mode => {
    if (mode === 'returned-error') auditStatus = 403;
    if (mode === 'throw') auditThrow = true;
    if (mode === 'missing-actor') state.user.mockResolvedValue(null);
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({
      ok: true, outcome: 'accepted', audit: 'unconfirmed', warning: 'userSecurityActions.resetAuditUnconfirmed',
    });
    expect(providerCalls()).toHaveLength(1);
  });
  it.each([null, [], [{}], [{ id: 'invalid' }], [{ id: AUDIT }, { id: ACTOR }]].map(rows => ({ rows })))('requires one valid audit ID receipt: $rows', async ({ rows }) => {
    auditRows = rows;
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({ ok: true, outcome: 'accepted', audit: 'unconfirmed' });
    expect(providerCalls()).toHaveLength(1);
  });
  it('confirms a checked audit write and preserves recipient and redirect parameters', async () => {
    expect(await adminSendPasswordResetAction(' target@example.invalid ')).toMatchObject({ ok: true, outcome: 'accepted', audit: 'recorded' });
    expect(providerCalls()).toHaveLength(1);
    expect(providerCalls()[0].body).toMatchObject({ email: 'target@example.invalid' });
    expect(providerCalls()[0].url.searchParams.get('redirect_to')).toBe('https://reset-fixture.invalid/auth/recovery');
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0].body).toMatchObject({ family_id: null, actor_id: ACTOR, action: 'password_reset', resource: 'users', metadata: { email: 'target@example.invalid', via: 'site_admin' } });
    expect(auditCalls()[0].signal).toBeInstanceOf(AbortSignal);
    expect(auditCalls()[0].url.searchParams.get('select')).toBe('id');
  });
  it('aborts a held audit request and preserves the accepted reset without resending', async () => {
    auditHeld = true;
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(ms === 5000 ? 10 : ms));
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({ ok: true, outcome: 'accepted', audit: 'unconfirmed' });
    expect(deadline).toHaveBeenCalledWith(5000);
    expect(auditCalls()[0].signal?.aborted).toBe(true);
    expect(providerCalls()).toHaveLength(1); expect(auditCalls()).toHaveLength(1);
  });
  it.each([400, 401, 403, 422, 429])('keeps definitive HTTP%s rejection retryable without an audit success', async status => {
    providerStatus = status;
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({ ok: false, outcome: 'failed' });
    expect(providerCalls()).toHaveLength(1); expect(auditCalls()).toEqual([]);
  });
  it.each([408, 500, 503])('keeps HTTP%s acceptance uncertainty explicit without retrying', async status => {
    providerStatus = status;
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({ ok: false, outcome: 'uncertain', error: 'userSecurityActions.resetUncertain' });
    expect(providerCalls()).toHaveLength(1); expect(auditCalls()).toEqual([]);
  });
  it.each(['lost-response', 'malformed-response'])('keeps %s uncertain without SDK resubmission', async mode => {
    providerThrow = mode === 'lost-response'; malformedProvider = mode === 'malformed-response';
    expect(await adminSendPasswordResetAction('target@example.invalid')).toMatchObject({ ok: false, outcome: 'uncertain' });
    expect(providerCalls()).toHaveLength(1); expect(auditCalls()).toEqual([]);
  });
  it.each(['denied', 'guard-throw', 'invalid-email', 'factory-throw'])('does not dispatch on %s', async mode => {
    if (mode === 'denied') state.allowed.mockResolvedValue(false);
    if (mode === 'guard-throw') state.allowed.mockRejectedValue(new Error('Synthetic guard read unavailable'));
    if (mode === 'factory-throw') state.factory.mockImplementation(() => { throw new Error('Synthetic configuration unavailable'); });
    expect(await adminSendPasswordResetAction(mode === 'invalid-email' ? 'not-an-email' : 'target@example.invalid')).toMatchObject({ ok: false, outcome: 'failed' });
    expect(requests).toEqual([]);
  });
});
