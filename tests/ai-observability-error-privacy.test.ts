import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';

// Whole literal boundary. No actual provider, SDK, Auth, store, native failure,
// stream or network producer is loaded or recreated here.
const fake = vi.hoisted(() => ({
  forbidden: [] as string[], fetchCalls: 0, defaultFetchCalls: 0,
  creates: [] as Array<{ scope: unknown; input: Record<string, unknown> }>,
  updates: [] as Array<{ scope: unknown; id: string; patch: Record<string, unknown> }>,
  usage: [] as Array<Record<string, unknown>>, plans: [] as unknown[],
  open: 'ok' as 'ok' | 'refused' | 'duplicate', level: 1, closeRefused: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/chat-request', () => ({ MAX_AI_REQUEST_TEXT_CHARS: 4000 }));
vi.mock('@/lib/ai/runs/store', () => ({
  createRequest: async (scope: unknown, input: Record<string, unknown>) => {
    fake.creates.push({ scope, input });
    return fake.open === 'refused' ? { ok: false, error: 'Synthetic filing refusal' }
      : { ok: true, data: { id: 'request-a', existing: fake.open === 'duplicate' } };
  },
  updateRequest: async (scope: unknown, id: string, patch: Record<string, unknown>) => {
    fake.updates.push({ scope, id, patch });
    if (fake.closeRefused && patch.completed_at) throw new Error('Synthetic close bookkeeping refusal');
    return { ok: true, data: null };
  },
}));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async (value: Record<string, unknown>) => { fake.usage.push(value); } }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async (...args: unknown[]) => { fake.plans.push(args); return fake.level; } }));
vi.mock('@supabase/supabase-js', () => { fake.forbidden.push('SDK'); throw Error('Forbidden SDK implementation'); });
vi.mock('@supabase/ssr', () => { fake.forbidden.push('SSR'); throw Error('Forbidden SSR implementation'); });
vi.mock('@supabase/auth-js', () => { fake.forbidden.push('Auth SDK'); throw Error('Forbidden Auth implementation'); });
vi.mock('@/lib/supabase/server', () => { fake.forbidden.push('server'); throw Error('Forbidden server implementation'); });
vi.mock('@/lib/supabase/client', () => { fake.forbidden.push('client'); throw Error('Forbidden client implementation'); });
vi.mock('@/lib/supabase/auth', () => { fake.forbidden.push('Auth'); throw Error('Forbidden Auth implementation'); });
vi.mock('@/shared/auth/refresh-fetch', () => { fake.forbidden.push('refresh'); throw Error('Forbidden refresh implementation'); });
vi.mock('@/lib/auth/cache-session', () => { fake.forbidden.push('cache-session'); throw Error('Forbidden cache implementation'); });
vi.mock('@/lib/auth/browser-session-storage', () => { fake.forbidden.push('session-storage'); throw Error('Forbidden session implementation'); });
vi.mock('@/lib/ai/provider', () => { fake.forbidden.push('provider'); throw Error('Forbidden provider implementation'); });
vi.mock('@/lib/ai/provider-stub', () => { fake.forbidden.push('provider-stub'); throw Error('Forbidden provider implementation'); });
vi.mock('@/lib/ai/routing', () => { fake.forbidden.push('routing'); throw Error('Forbidden routing implementation'); });
vi.mock('next/cache', () => { fake.forbidden.push('next/cache'); throw Error('Forbidden cache implementation'); });

type Guard = { snapshot(): { forbiddenImports: string[]; fetchCalls: number }; recordFetch(): never };
const defaultGuard: Guard = {
  snapshot: () => ({ forbiddenImports: [...fake.forbidden], fetchCalls: fake.defaultFetchCalls }),
  recordFetch: () => { fake.defaultFetchCalls++; throw Error('Forbidden observability network'); },
};
const guard = process.env.BUBALY_ADAPTER_PHASE
  ? (globalThis as unknown as Record<symbol, Guard>)[Symbol.for('bubaly.ai.observability.privacy.guard.v1')]
  : defaultGuard;
if (!guard || typeof guard.snapshot !== 'function' || typeof guard.recordFetch !== 'function') throw Error('Required observability privacy guard is absent');
const importSnapshot = guard.snapshot();
expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 });
function boundary() {
  expect(fake.forbidden).toEqual([]); expect(fake.fetchCalls).toBe(0); expect(fake.defaultFetchCalls).toBe(0);
  expect(guard.snapshot()).toEqual({ forbiddenImports: [], fetchCalls: 0 });
}
const PRIVATE = 'PRIVATE_SYNTHETIC_NOTE_DESTINATION';
const fallback = 'AI request failed.';
const safeHttp = (status: number) => `Provider request failed (HTTP ${status}).`;
const scope = { db: {}, familyId: 'family-a', userId: 'user-a', memberId: 'member-a', role: 'parent', actorKind: 'member', tz: 'UTC' } as unknown as ServiceScope;
const spec = { feature: 'privacy.literal', text: 'Fixed safe label' };
async function module() { return import('@/lib/ai/observability'); }
function closing() { return fake.updates.at(-1)?.patch ?? {}; }
function safeClose(expected: string, status = 'failed') {
  expect(closing()).toMatchObject({ status, error: expected });
  expect(JSON.stringify(fake.updates)).not.toContain(PRIVATE);
}
async function thrown(value: unknown) {
  const { withAiRequest } = await module();
  let caught = false, actual: unknown;
  try { await withAiRequest(scope, spec, async () => { throw value; }); }
  catch (error) { caught = true; actual = error; }
  expect(caught).toBe(true); expect(actual).toBe(value);
}
async function handled(value: unknown, partial = false) {
  const { withAiRequest } = await module();
  const answer = { result: 'Original response object' };
  expect(await withAiRequest(scope, spec, async obs => { obs.failed(value, { partial }); return answer; })).toBe(answer);
}
function httpError(status: number) { return Object.defineProperty(new Error(PRIVATE), 'status', { value: status, enumerable: false }); }

beforeEach(() => {
  fake.creates = []; fake.updates = []; fake.usage = []; fake.plans = [];
  fake.open = 'ok'; fake.level = 1; fake.closeRefused = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', () => { fake.fetchCalls++; return guard.recordFetch(); });
  boundary();
});
afterEach(() => { boundary(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 }); boundary(); });

describe('family-readable AI request errors contain categories, never private diagnostics', () => {
  it('keeps an own numeric HTTP category and the identical thrown error without its private message', async () => {
    const error = httpError(503); await thrown(error); safeClose(safeHttp(503));
  });
  it('redacts a handled numeric HTTP error and preserves the original body return', async () => {
    await handled(httpError(429)); safeClose(safeHttp(429));
  });
  it('redacts a numeric HTTP partial error while preserving partially_completed', async () => {
    await handled(httpError(502), true); safeClose(safeHttp(502), 'partially_completed');
  });
  it('uses the fixed fallback for a statusless thrown Error and preserves its identity', async () => {
    const error = new Error(PRIVATE); await thrown(error); safeClose(fallback);
  });
  it('uses the fixed fallback for a statusless handled Error', async () => {
    await handled(new Error(PRIVATE)); safeClose(fallback);
  });
  it('uses the fixed fallback for a statusless partial literal stream-shaped error', async () => {
    await handled(new Error(PRIVATE), true); safeClose(fallback, 'partially_completed');
  });
  it('never stores a thrown private string and rethrows the same primitive', async () => {
    await thrown(PRIVATE); safeClose(fallback);
  });
  it('never reads a plain object message into the ledger and preserves the object identity', async () => {
    const error = { message: PRIVATE, detail: PRIVATE }; await thrown(error); safeClose(fallback);
  });
  it('records the fixed fallback for a thrown null value without replacing it', async () => {
    await thrown(null); safeClose(fallback);
  });
  it('records the fixed fallback for an explicitly handled undefined value', async () => {
    await handled(undefined); safeClose(fallback);
  });
  it('does not invoke a custom toString even when it would throw private diagnostics', async () => {
    let reads = 0; const error = { toString() { reads++; throw Error(PRIVATE); } };
    await thrown(error); safeClose(fallback); expect(reads).toBe(0);
  });
  it('does not invoke status or message accessors while producing its safe fallback', async () => {
    let reads = 0; const error = new Error();
    Object.defineProperties(error, { status: { get() { reads++; return 503; } }, message: { get() { reads++; return PRIVATE; } }, name: { get() { reads++; return PRIVATE; } }, publicErrorCode: { get() { reads++; return 'request_stopped'; } } });
    await thrown(error); safeClose(fallback); expect(reads).toBe(0);
  });
  it('ignores an inherited status getter instead of invoking it', async () => {
    let reads = 0; const error = Object.create({ get status() { reads++; return 401; } }) as object;
    await thrown(error); safeClose(fallback); expect(reads).toBe(0);
  });
  it('ignores noninteger, string and out-of-range own status values', async () => {
    for (const status of [399, 600, 401.5, '503', NaN, Infinity, -1]) {
      const error = { status, message: PRIVATE }; await thrown(error); safeClose(fallback);
    }
  });
  it('catches reflection refusal from a literal Proxy and preserves the original thrown value', async () => {
    const error = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('Synthetic descriptor refusal'); } });
    await thrown(error); safeClose(fallback);
  });
  it('keeps the first handled failure category when another failure follows', async () => {
    const { withAiRequest } = await module();
    expect(await withAiRequest(scope, spec, async obs => { obs.failed(httpError(401)); obs.failed(httpError(503)); return 'handled'; })).toBe('handled');
    safeClose(safeHttp(401));
  });
  it('keeps the first partial failure partial when a nonpartial failure follows', async () => {
    const { withAiRequest } = await module();
    await withAiRequest(scope, spec, async obs => { obs.failed(httpError(502), { partial: true }); obs.failed(httpError(500)); });
    safeClose(safeHttp(502), 'partially_completed');
  });
  it('keeps a fixed safe HTTP message safe while deriving its category only from own numeric data', async () => {
    const error = Object.defineProperty(new Error(safeHttp(400)), 'status', { value: 400 });
    await handled(error); safeClose(safeHttp(400));
  });
  it('preserves healthy usage, scope, single latency charge, allowance and retry-key behavior', async () => {
    const { withAiRequest, AiRequestNotFiled, AiRequestDuplicate } = await module();
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(1010);
    const response = { healthy: true };
    expect(await withAiRequest(scope, spec, async obs => { obs.used('synthetic-model-a', { inputTokens: 2, outputTokens: 3, totalTokens: 5 }); obs.used('synthetic-model-b'); return response; })).toBe(response);
    expect(fake.creates[0]).toMatchObject({ scope, input: { requestText: 'Fixed safe label', feature: spec.feature, kind: 'feature' } });
    expect(fake.updates[0]).toMatchObject({ scope, id: 'request-a', patch: { status: 'executing' } });
    expect(closing()).toMatchObject({ status: 'completed' }); expect(closing()).not.toHaveProperty('error'); expect(closing()).not.toHaveProperty('latency_ms');
    expect(fake.usage).toHaveLength(2);
    expect(fake.usage[0]).toMatchObject({ db: scope.db, familyId: scope.familyId, requestId: 'request-a', task: spec.feature, model: 'synthetic-model-a', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, ok: true, latencyMs: 10 });
    expect(fake.usage[1]).toMatchObject({ latencyMs: 0 });
    let bodyCalls = 0; fake.open = 'refused'; fake.level = 0;
    await expect(withAiRequest(scope, spec, async () => { bodyCalls++; })).rejects.toBeInstanceOf(AiRequestNotFiled);
    fake.level = 1;
    expect(await withAiRequest(scope, spec, async () => { bodyCalls++; return 'unmetered'; })).toBe('unmetered');
    await expect(withAiRequest(scope, { ...spec, clientRequestId: 'synthetic-key' }, async () => { bodyCalls++; })).rejects.toBeInstanceOf(AiRequestNotFiled);
    fake.open = 'duplicate';
    await expect(withAiRequest(scope, { ...spec, clientRequestId: 'synthetic-key' }, async () => { bodyCalls++; })).rejects.toBeInstanceOf(AiRequestDuplicate);
    expect(bodyCalls).toBe(1);
  });
  it('keeps the original body failure even when literal close bookkeeping is refused', async () => {
    fake.closeRefused = true; const error = httpError(504); await thrown(error); safeClose(safeHttp(504));
    expect(fake.updates.filter(call => call.patch.completed_at)).toHaveLength(1);
  });
  it('keeps a controlled own public stop category without copying its private message or replacing the thrown object', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'request_stopped', enumerable: false });
    await thrown(error); safeClose('AI request stopped.');
  });
  it('records only the controlled chore_plan_parse category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'chore_plan_parse', enumerable: false });
    await thrown(error); safeClose('The chore plan did not parse as a JSON array.');
    await handled(error, true); safeClose('The chore plan did not parse as a JSON array.', 'partially_completed');
  });
  it('records only the controlled provider_auth category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_auth', enumerable: false });
    await thrown(error); safeClose('The model provider failed (auth).');
    await handled(error, true); safeClose('The model provider failed (auth).', 'partially_completed');
  });
  it('records only the controlled provider_quota category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_quota', enumerable: false });
    await thrown(error); safeClose('The model provider failed (quota).');
    await handled(error, true); safeClose('The model provider failed (quota).', 'partially_completed');
  });
  it('records only the controlled provider_rate_limit category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_rate_limit', enumerable: false });
    await thrown(error); safeClose('The model provider failed (rate_limit).');
    await handled(error, true); safeClose('The model provider failed (rate_limit).', 'partially_completed');
  });
  it('records only the controlled provider_model category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_model', enumerable: false });
    await thrown(error); safeClose('The model provider failed (model).');
    await handled(error, true); safeClose('The model provider failed (model).', 'partially_completed');
  });
  it('records only the controlled provider_network category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_network', enumerable: false });
    await thrown(error); safeClose('The model provider failed (network).');
    await handled(error, true); safeClose('The model provider failed (network).', 'partially_completed');
  });
  it('records only the controlled provider_unknown category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_unknown', enumerable: false });
    await thrown(error); safeClose('The model provider failed (unknown).');
    await handled(error, true); safeClose('The model provider failed (unknown).', 'partially_completed');
  });
  it('records only the controlled provider_cancelled category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_cancelled', enumerable: false });
    await thrown(error); safeClose('The model provider failed (cancelled).');
    await handled(error, true); safeClose('The model provider failed (cancelled).', 'partially_completed');
  });
  it('records only the controlled provider_unconfigured category while preserving thrown identity and partial status', async () => {
    const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value: 'provider_unconfigured', enumerable: false });
    await thrown(error); safeClose('The model provider failed (unconfigured).');
    await handled(error, true); safeClose('The model provider failed (unconfigured).', 'partially_completed');
  });
  it('does not coerce unknown, nonstring or prototype-like own public codes into a category', async () => {
    let coercions = 0;
    const opaque = { toString() { coercions++; throw Error('Unexpected literal coercion'); }, valueOf() { coercions++; throw Error('Unexpected literal coercion'); } };
    for (const value of [undefined, null, false, 503, 'unapproved_code', '__proto__', 'constructor', 'toString', opaque]) {
      const error = Object.defineProperty(new Error(PRIVATE), 'publicErrorCode', { value });
      await thrown(error); safeClose(fallback);
    }
    expect(coercions).toBe(0);
  });
  it('ignores inherited public-code data and getters without invoking them', async () => {
    let reads = 0;
    for (const prototype of [{ publicErrorCode: 'provider_auth' }, { get publicErrorCode() { reads++; return 'provider_auth'; } }]) {
      const error = Object.create(prototype) as object;
      Object.defineProperty(error, 'message', { value: PRIVATE });
      await thrown(error); safeClose(fallback);
    }
    expect(reads).toBe(0);
  });
  it('prioritizes a recognized own public code while retaining HTTP fallback for an unknown own code', async () => {
    const known = Object.defineProperties(new Error(PRIVATE), { publicErrorCode: { value: 'provider_auth' }, status: { value: 503 } });
    await thrown(known); safeClose('The model provider failed (auth).');
    const unknown = Object.defineProperties(new Error(PRIVATE), { publicErrorCode: { value: 'unapproved_code' }, status: { value: 503 } });
    await thrown(unknown); safeClose(safeHttp(503));
  });
});