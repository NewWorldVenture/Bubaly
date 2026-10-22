import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

// H18 — four endpoints that call a model checked only for a session:
// /api/ai/meals/plan, /api/ai/meals/nutrition, /api/recipes/suggest and
// /api/recipes/transform. The (app) layout's TrialPaywallGate is a page
// overlay; a trial-expired or closed family still POSTed here with its session
// cookie and got paid model calls (and the planner's and transform's writes).
// An admin switching Meals Off closed the page (requireFeature) and left both
// meals endpoints serving. Each now asks the same resolver its page does
// (refuseUnlessEntitled), before the rate limiter and the provider.

const h = vi.hoisted(() => ({
  entitlement: { allowed: true, planLevel: 0 } as Record<string, unknown>,
  hrefs: [] as string[],
  complete: vi.fn(),
  limit: vi.fn(),
  from: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/server/feature-entitlement', () => ({
  resolveFeatureEntitlement: async (_db: unknown, _family: string, href: string) => { h.hrefs.push(href); return h.entitlement; },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({ from: h.from }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
  describeAIError: () => ({ message: 'unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: h.limit }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const ROUTES = [
  { path: 'app/api/ai/meals/plan/route.ts', href: '/dashboard/meals', body: { weekStart: '2026-09-14', write: true } },
  { path: 'app/api/ai/meals/nutrition/route.ts', href: '/dashboard/meals', body: { subjectType: 'meal', subjectId: 'meal-1', refresh: true } },
  { path: 'app/api/recipes/suggest/route.ts', href: '/dashboard/recipes', body: { constraint: 'quick' } },
  { path: 'app/api/recipes/transform/route.ts', href: '/dashboard/recipes', body: { recipeId: 'recipe-1', actionId: 'healthier' } },
] as const;

const post = async (path: string, body: unknown) => {
  const { POST } = (await import(`@/${path.replace(/\.ts$/, '')}`)) as { POST: (req: NextRequest) => Promise<Response> };
  return POST(new NextRequest('https://app.example.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
};

beforeEach(() => {
  h.hrefs = [];
  h.complete.mockReset();
  h.limit.mockReset().mockResolvedValue({ ok: true });
  h.from.mockReset().mockImplementation(() => { throw new Error('no database read should happen for a refused family'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(ROUTES)('$path answers to its page\'s feature', (route) => {
  it('refuses a trial-expired family before the rate limiter, the database and the model', async () => {
    h.entitlement = { allowed: false, reason: 'locked', code: 'trial_expired', needLevel: 1, planLevel: 0 };

    const response = await post(route.path, route.body);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'trial_expired' });
    expect(h.hrefs).toEqual([route.href]);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('refuses a closed account', async () => {
    h.entitlement = { allowed: false, reason: 'locked', code: 'account_closed', needLevel: 1, planLevel: 0 };

    const response = await post(route.path, route.body);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'account_closed' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('answers 404 when an admin has switched the feature off, as the page does', async () => {
    h.entitlement = { allowed: false, reason: 'off', needLevel: 0, planLevel: 0 };

    const response = await post(route.path, route.body);

    expect(response.status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('gates before anything is spent, in the source too', () => {
    const source = readFileSync(route.path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const gate = source.indexOf(`refuseUnlessEntitled(supabase, `);
    expect(gate).toBeGreaterThan(-1);
    expect(source).toContain(`['${route.href}']`);
    for (const spent of ['enforceAIRateLimit(', 'resolveProvider(']) {
      const at = source.indexOf(spent);
      expect(at, spent).toBeGreaterThan(-1);
      expect(gate, `${spent} must come after the gate`).toBeLessThan(at);
    }
  });
});
