import { beforeEach, describe, expect, it, vi } from 'vitest';

// Found by the API sweep (scripts/api-audit): POST /api/ai/savings answered a
// signed-in CHILD with advice built from the family's transactions, budgets,
// unpaid bills and subscriptions — "Trim Dining spending: you're $32 over your
// Dining budget", "Cancel 2 unused subscriptions (Netflix $15.49/mo, …)".
//
// Everywhere else the family's finances are the adults': the finance service
// refuses a non-manager (lib/services/finances: "Family finances are private
// to the adults in this family"), and the privacy export withholds its
// `finances` section from a child. This route read the same tables through its
// own queries and never asked.

const mocks = vi.hoisted(() => ({ role: 'child', reads: [] as string[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: vi.fn(async () => ({ user: { id: 'u' }, active: { role: mocks.role, familyId: 'f', family: { timezone: 'UTC' } } })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: (table: string) => {
    mocks.reads.push(table);
    const b = { select: () => b, eq: () => b, neq: () => b, gte: () => b, order: () => b, range: async () => ({ data: [], error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }) };
    return b;
  } }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: vi.fn(), isAIConfigured: async () => false }));

beforeEach(() => { mocks.reads = []; });

describe('savings advice is for the adults who run the family money', () => {
  it.each(['child', 'teen', 'guest'])('refuses a %s before reading any finance table', async (role) => {
    mocks.role = role;
    const { POST } = await import('@/app/api/ai/savings/route');
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'savings.privateToTheAdults' });
    expect(mocks.reads).toEqual([]);
  });

  it.each(['parent', 'adult'])('still answers a %s', async (role) => {
    mocks.role = role;
    const { POST } = await import('@/app/api/ai/savings/route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.reads).toEqual(expect.arrayContaining(['transactions', 'budgets', 'bills', 'subscriptions_tracked']));
  });
});
