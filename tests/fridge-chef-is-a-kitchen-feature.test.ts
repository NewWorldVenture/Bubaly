// Fridge Chef's only entry point is the Smart Kitchen dashboard (Basic), and it
// runs a paid vision-model call per photo. Before this, neither its page nor its
// route checked the plan, and no photo counted toward the Free AI allowance:
// a Free or trial-expired family could POST photos straight to the route.
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  level: 0, locked: false,
  requests: [] as Record<string, unknown>[],
  fetch: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = { user: { id: 'user-a', email: 'parent@example.test' }, memberships: [],
    active: { familyId: 'family-a', role: 'parent', member: { id: 'member-a' }, family: { name: 'Fixture', timezone: 'UTC' } } };
  return { requireUserContext: async () => ctx, getUserContext: async () => ctx, isSuperAdmin: async () => false };
});
vi.mock('@/lib/supabase/server', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder, eq: () => builder,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  });
  const db = { from: () => builder, rpc: async () => ({ data: 0, error: null }) };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => h.level,
  resolveFamilyEntitlement: async () => ({ effectiveLevel: h.level, locked: h.locked, closed: false, inTrial: false, trialEndsAt: null }),
}));
vi.mock('@/lib/server/feature-tiers', () => ({
  getFeatureTiersByHref: async () => ({ '/dashboard/kitchen': 'basic' }),
  getResolvedFeatureTiers: async () => ({ 'smart-kitchen': 'basic' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: async () => ({ openaiKey: 'sk-fixture', model: 'gpt-4o' }) }));
vi.mock('@/lib/ai/runs/store', () => ({
  createRequest: async (_scope: unknown, input: Record<string, unknown>) => { h.requests.push(input); return { ok: true, data: { id: 'req-1' } }; },
  updateRequest: async () => ({ ok: true }),
}));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => {} }));

import { POST } from '@/app/api/ai/pantry-chef/route';

const photo = () => new NextRequest('https://app.example.test/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: 'aGVsbG8=', mediaType: 'image/png' }),
});

beforeEach(() => {
  h.level = 0; h.locked = false; h.requests = [];
  h.fetch.mockReset().mockImplementation(async () => Response.json({ choices: [{ message: { content: '[{"title":"Soup"}]' } }] }));
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('POST /api/ai/pantry-chef', () => {
  it('refuses a Free family before any model call', async () => {
    const response = await POST(photo());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refuses a trial-expired family before any model call', async () => {
    h.locked = true;
    const response = await POST(photo());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'trial_expired' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('serves a Basic family and records the call as an AI request', async () => {
    h.level = 1;
    const response = await POST(photo());
    expect(response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.requests).toEqual([expect.objectContaining({ feature: 'kitchen.fridge_chef' })]);
  });
});

describe('the Fridge Chef page', () => {
  it('carries the Smart Kitchen plan gate', () => {
    const page = readFileSync('app/(app)/dashboard/fridge-chef/page.tsx', 'utf8');
    expect(page).toContain("await requireFeature('/dashboard/kitchen')");
  });
});
