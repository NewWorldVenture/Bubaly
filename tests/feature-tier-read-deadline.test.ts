import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// The feature-tier settings read (`app_settings.feature_tiers`) had no
// deadline. /pricing, the app shell's nav and every feature gate wait on it, so
// a stalled data API held all of them open for as long as the stall lasted.
//
// The fix bounds the read and splits what a failure means by caller:
//   display (pricing, nav, admin listing) — the catalog defaults, as before;
//   access  (resolveFeatureEntitlement, the autopilot cron, ai-access) — no
//           answer. A failed lookup must never grant a feature: an admin can
//           make a feature stricter than its catalog default, and the default
//           would open what the admin closed.
//
// Real supabase-js and the real tier modules over a synthetic data API. The
// budget's timer is replaced so the test decides when it runs out. The plan
// read is mocked (it is not what is under test). No network or database.
type DB = SupabaseClient<Database>;

const plan = vi.hoisted(() => ({ level: 0 }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: vi.fn(async () => plan.level) }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: vi.fn(async () => false) }));

// 'ai-assistant' defaults to free in the catalog. The admin has made it Plus.
const ASSISTANT_HREF = '/dashboard/assistant';
const OVERRIDES = { 'ai-assistant': 'plus' };

let dataApi: 'healthy' | 'error' | 'stalled' = 'healthy';
let budgets: Array<{ ms: number; controller: AbortController }> = [];
let requestSignals: Array<AbortSignal | undefined> = [];

beforeEach(() => {
  dataApi = 'healthy';
  budgets = [];
  requestSignals = [];
  plan.level = 0;
  vi.resetModules();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    budgets.push({ ms, controller });
    return controller.signal;
  });
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
    expect(String(input)).toContain('/rest/v1/app_settings');
    const signal = init?.signal ?? undefined;
    requestSignals.push(signal);
    if (dataApi === 'healthy') {
      return Promise.resolve(new Response(JSON.stringify([{ value: OVERRIDES }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (dataApi === 'error') {
      return Promise.resolve(new Response(JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true });
    });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

const db = (): DB => createClient<Database>('http://127.0.0.1:1', 'synthetic-anon', { auth: { persistSession: false } });

async function flush() { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }

/**
 * Starts `read`, checks it is still waiting while the data API is stalled, then
 * ends the read's budget. Returns how the read settled.
 */
async function throughStall<T>(read: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let settled = false;
  const outcome: { value?: T; error?: unknown } = {};
  const pending = read().then((value) => { outcome.value = value; }, (error) => { outcome.error = error; }).finally(() => { settled = true; });
  await flush();
  expect(settled, 'a stalled settings read waits for its budget').toBe(false);
  expect(budgets.map((b) => b.ms), 'the settings read has a deadline').toEqual([3_000]);
  for (const { controller } of budgets) controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  await pending;
  // Cancellation: the request itself was handed the budget and aborted, not
  // left running behind a race.
  expect(requestSignals.length).toBeGreaterThan(0);
  expect(requestSignals.every((s) => s?.aborted)).toBe(true);
  return outcome;
}

describe('the feature-tier settings read: display callers', () => {
  it('healthy: the admin override is the effective tier', async () => {
    const { getResolvedFeatureTiers, getFeatureTiersByHref } = await import('@/lib/server/feature-tiers');
    expect((await getResolvedFeatureTiers(db()))['ai-assistant']).toBe('plus');
    expect((await getFeatureTiersByHref(db()))[ASSISTANT_HREF]).toBe('plus');
  });

  it('error: the catalog defaults, as before', async () => {
    dataApi = 'error';
    const { getResolvedFeatureTiers } = await import('@/lib/server/feature-tiers');
    expect((await getResolvedFeatureTiers(db()))['ai-assistant']).toBe('free');
  });

  it('timeout: the catalog defaults, within the budget', async () => {
    dataApi = 'stalled';
    const { getResolvedFeatureTiers } = await import('@/lib/server/feature-tiers');
    const { value } = await throughStall(() => getResolvedFeatureTiers(db()));
    expect(value?.['ai-assistant']).toBe('free');
  });
});

describe('the feature-tier settings read: access decisions never grant on a failed lookup', () => {
  it('healthy: a free family is refused the feature the admin made Plus', async () => {
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).toEqual({ allowed: false, reason: 'plan', needLevel: 2, planLevel: 0 });
  });

  it('error: no answer, never the catalog default that would grant it', async () => {
    dataApi = 'error';
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    await expect(resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).rejects.toThrow(/feature tiers/i);
  });

  it('timeout: no answer, within the budget', async () => {
    dataApi = 'stalled';
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    const { value, error } = await throughStall(() => resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF));
    expect(value).toBeUndefined();
    expect(String(error)).toMatch(/feature tiers/i);
  });

  it('the failure is not cached as an answer: the next read after recovery decides', async () => {
    dataApi = 'error';
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    await expect(resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).rejects.toThrow();
    dataApi = 'healthy';
    plan.level = 2;
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF)).toEqual({ allowed: true, planLevel: 2 });
  });
});

describe('callers keep their existing failure answers', () => {
  it('an API route gate answers 503 "could not confirm", not 403 and not a pass', async () => {
    dataApi = 'stalled';
    const { refuseUnlessEntitled } = await import('@/lib/server/route-feature-gate');
    const { value } = await throughStall(() => refuseUnlessEntitled(db(), 'family-1', [ASSISTANT_HREF]));
    expect(value?.status).toBe(503);
    expect(await value?.json()).toMatchObject({ code: 'unavailable' });
  });

  it('a page preview check proceeds as before (the route behind it answers the failure)', async () => {
    dataApi = 'error';
    const { isFeaturePreviewOnly } = await import('@/lib/server/feature-entitlement');
    expect(await isFeaturePreviewOnly(db(), 'family-1', ASSISTANT_HREF)).toBe(false);
  });

  it('a caller passing a tier map it already read is unchanged', async () => {
    const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
    expect(await resolveFeatureEntitlement(db(), 'family-1', ASSISTANT_HREF, { [ASSISTANT_HREF]: 'free' })).toEqual({ allowed: true, planLevel: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
