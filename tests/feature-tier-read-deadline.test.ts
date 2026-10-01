import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// The feature-tier settings read (`app_settings.feature_tiers`) had no
// deadline. The app shell's nav, the admin listing and every feature gate wait
// on it, so a stalled data API held all of them open for as long as the stall
// lasted. (/pricing has its own bounded reader since #729.)
//
// The fix bounds the WHOLE read and splits what a failure means by caller:
//   display (nav, admin listing) — the catalog defaults, as before;
//   access  (resolveFeatureEntitlement, the autopilot cron, ai-access) — no
//           answer. A failed lookup must never grant a feature: an admin can
//           make a feature stricter than its catalog default, and the default
//           would open what the admin closed.
//
// "The whole read" is the point of the stall modes below (review 5379178080).
// An abort signal only reaches the fetch. It does not end an SDK access-token
// lookup that never returns, a transport that ignores the signal, or a body
// that never finishes; the deadline has to settle the read itself.
//
// Real supabase-js and the real tier modules over a synthetic data API, under
// fake timers. The plan read is mocked (it is not what is under test). No
// network or database.
type DB = SupabaseClient<Database>;
type Mode = 'healthy' | 'error' | 'stalled' | 'ignores-abort' | 'body' | 'token';

const plan = vi.hoisted(() => ({ level: 0 }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: vi.fn(async () => plan.level) }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: vi.fn(async () => false) }));

const BUDGET_MS = 3_000;
// 'ai-assistant' defaults to free in the catalog. The admin has made it Plus.
const ASSISTANT_HREF = '/dashboard/assistant';
const OVERRIDES = { 'ai-assistant': 'plus' };
const STALLS = ['stalled', 'ignores-abort', 'body', 'token'] as const;

let mode: Mode = 'healthy';
let requestSignals: Array<AbortSignal | undefined> = [];
let releases: Array<() => void> = [];

const held = () => new Promise<void>((resolve) => { releases.push(resolve); });

async function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  expect(String(input instanceof Request ? input.url : input)).toContain('/rest/v1/app_settings');
  const signal = init?.signal ?? undefined;
  requestSignals.push(signal);
  if (mode === 'error') {
    return Response.json({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, { status: 500 });
  }
  if (mode === 'stalled') {
    // Honours the signal: settles only when the request is aborted.
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true });
    });
  }
  // Ignores the signal entirely, as a stuck transport can.
  if (mode === 'ignores-abort') await held();
  const response = Response.json([{ value: OVERRIDES }]);
  if (mode === 'body') {
    const text = response.text.bind(response);
    response.text = async () => { await held(); return text(); };
  }
  return response;
}

beforeEach(() => {
  mode = 'healthy';
  requestSignals = [];
  releases = [];
  plan.level = 0;
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(transport));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const db = (): DB => createClient<Database>('http://127.0.0.1:1', 'synthetic-anon', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // The SDK resolves an access token before every request. 'token' makes that
  // lookup hang; no request is ever sent, so no signal can reach it.
  ...(mode === 'token' ? { accessToken: async () => { await held(); return 'synthetic-token'; } } : {}),
});

/**
 * Starts `read` against a stalled path and checks it settles at the budget,
 * not before and not after, with nothing left running.
 */
async function throughStall<T>(read: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let settled = false;
  const outcome: { value?: T; error?: unknown } = {};
  const pending = read().then((value) => { outcome.value = value; }, (error) => { outcome.error = error; }).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
  expect(settled, `the read waits while the data path is stalled (${mode})`).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(settled, `the read settles at its ${BUDGET_MS} ms budget (${mode})`).toBe(true);
  await pending;
  // Cancellation: any request that went out was aborted, not left running
  // behind the deadline. (A hung token lookup sends no request at all.)
  expect(requestSignals.every((s) => s?.aborted)).toBe(true);
  if (mode === 'token') expect(requestSignals).toHaveLength(0);
  else expect(requestSignals.length).toBeGreaterThan(0);
  // A late answer after the deadline changes nothing, and no timer is left.
  releases.splice(0).forEach((release) => release());
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  return outcome;
}

describe('the feature-tier settings read: display callers', () => {
  it('healthy: the admin override is the effective tier, and no timer is left behind', async () => {
    const { getResolvedFeatureTiers, getFeatureTiersByHref } = await import('@/lib/server/feature-tiers');
    expect((await getResolvedFeatureTiers(db()))['ai-assistant']).toBe('plus');
    expect((await getFeatureTiersByHref(db()))[ASSISTANT_HREF]).toBe('plus');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('error: the catalog defaults, as before', async () => {
    mode = 'error';
    const { getResolvedFeatureTiers } = await import('@/lib/server/feature-tiers');
    const pending = getResolvedFeatureTiers(db());
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1);
    expect((await pending)['ai-assistant']).toBe('free');
  });

  it.each(STALLS)('%s: the catalog defaults, at the budget', async (stall) => {
    mode = stall;
    const { getResolvedFeatureTiers } = await import('@/lib/server/feature-tiers');
    const { value } = await throughStall(() => getResolvedFeatureTiers(db()));
    expect(value?.['ai-assistant']).toBe('free');
  });
});

describe('the feature-tier settings read: access decisions never grant on a failed lookup', () => {
  it('healthy: a free family is refused the feature the admin made Plus; a Plus family has it', async () => {
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).toEqual({ allowed: false, reason: 'plan', needLevel: 2, planLevel: 0 });
    plan.level = 2;
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).toEqual({ allowed: true, planLevel: 2 });
  });

  it('error: no answer, never the catalog default that would grant it', async () => {
    mode = 'error';
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    const pending = resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF);
    const assertion = expect(pending).rejects.toThrow(/feature tiers/i);
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1);
    await assertion;
  });

  it.each(STALLS)('%s: no answer, at the budget', async (stall) => {
    mode = stall;
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    const { value, error } = await throughStall(() => resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF));
    expect(value).toBeUndefined();
    expect(String(error)).toMatch(/feature tiers/i);
  });

  it('the failure is not cached as an answer: the next read after recovery decides', async () => {
    mode = 'ignores-abort';
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    await throughStall(() => resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF));
    mode = 'healthy';
    plan.level = 2;
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).toEqual({ allowed: true, planLevel: 2 });
  });
});

describe('callers keep their existing failure answers', () => {
  it('an API route gate answers 503 "could not confirm", not 403 and not a pass', async () => {
    mode = 'ignores-abort';
    const { refuseUnlessEntitled } = await import('@/lib/server/route-feature-gate');
    const { value } = await throughStall(() => refuseUnlessEntitled(db(), 'family-1', [ASSISTANT_HREF]));
    expect(value?.status).toBe(503);
    expect(await value?.json()).toMatchObject({ code: 'unavailable' });
  });

  it('a page preview check proceeds as before (the route behind it answers the failure)', async () => {
    mode = 'error';
    const { isFeaturePreviewOnly } = await import('@/lib/server/feature-entitlement');
    const pending = isFeaturePreviewOnly(db(), 'family-1', ASSISTANT_HREF);
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1);
    expect(await pending).toBe(false);
  });

  it('a caller passing a tier map it already read is unchanged', async () => {
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF, { [ASSISTANT_HREF]: 'free' })).toEqual({ allowed: true, planLevel: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
