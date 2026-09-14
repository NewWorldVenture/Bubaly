// The monthly AI allowance, exercised for the first time.
//
// `AI_MONTHLY_ALLOWANCE` shipped as `{0: null, 1: null, 2: null}` — unlimited at
// every level — with a comment saying the numbers would land "when the plans
// define them". The plans had defined them: Free is sold "10 AI requests/month"
// and Basic "Unlimited AI assistant & concierge". So the count query, the 429
// branch and the error copy below had never executed, in a test or in
// production, on any request ever made. Setting the Free allowance to 10 turns
// all three on at once.
//
// Code that has never run is not code that works. Every branch is driven here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveFamilyPlanLevel = vi.fn();
const getResolvedFeatureTiers = vi.fn();

vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: (...a: unknown[]) => resolveFamilyPlanLevel(...a) }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: (...a: unknown[]) => getResolvedFeatureTiers(...a),
  getFeatureTiersByHref: vi.fn(),
}));

/** A db whose `ai_requests` count answers with whatever this test wants. */
function db(count: number | null, error: unknown = null) {
  const calls: { table: string; filters: Array<[string, unknown]> }[] = [];
  const make = (table: string) => {
    const entry = { table, filters: [] as Array<[string, unknown]> };
    calls.push(entry);
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { entry.filters.push([col, val]); return chain; },
      gte: (col: string, val: unknown) => { entry.filters.push([col, val]); return chain; },
      then: (resolve: (v: unknown) => unknown) => resolve({ count, error }),
    };
    return chain;
  };
  return { client: { from: (t: string) => make(t) } as never, calls };
}

const ctx = (email = 'parent@example.com') => ({
  user: { id: 'user-1', email },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam' } },
}) as never;

const NOW = new Date('2026-09-13T12:00:00.000Z');

beforeEach(() => {
  resolveFamilyPlanLevel.mockResolvedValue(0);
  getResolvedFeatureTiers.mockResolvedValue({ 'ai-assistant': 'free', 'ai-requests': 'basic', 'ai-concierge': 'basic' });
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Free plan gets the ten requests it was sold', () => {
  it('allows a request under the allowance and reports the usage', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(3);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: true, planLevel: 0, monthlyUsed: 3, monthlyAllowance: 10 });
  });

  it('refuses the eleventh with a 429 that names the number and the upgrade', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY, AI_MONTHLY_ALLOWANCE } = await import('@/lib/server/ai-access');
    const { client } = db(AI_MONTHLY_ALLOWANCE[0]!);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 429, code: 'allowance_exceeded' });
    expect((access as { error: string }).error).toContain(String(AI_MONTHLY_ALLOWANCE[0]));
    expect((access as { error: string }).error).toMatch(/Family Basic/);
  });

  // Fail closed. An allowance that cannot be checked is not an allowance — but
  // it is also not a refusal of the feature, so the code says `unavailable`.
  it('fails closed when the usage count cannot be read', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(null, { message: 'boom' });
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  // The defect this replaced: the count filtered `kind = 'concierge'`, and the
  // assistant files its turns under the default kind 'feature'. A meter that
  // counted only concierge rows read zero forever.
  it('counts the month by family alone, with no kind filter', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(1);
    await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    const query = calls.find((c) => c.table === 'ai_requests');
    expect(query, 'no ai_requests count was issued').toBeTruthy();
    const columns = query!.filters.map(([c]) => c);
    expect(columns).toContain('family_id');
    expect(columns).toContain('created_at');
    expect(columns, 'a kind filter would exclude every assistant turn').not.toContain('kind');
  });

  it('counts from the start of the UTC month', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(1);
    await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    const since = calls.find((c) => c.table === 'ai_requests')!.filters.find(([c]) => c === 'created_at')![1];
    expect(since).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('the plans above Free are unlimited, and cost nothing to check', () => {
  it.each([[1], [2]])('level %i is allowed without issuing a count', async (level) => {
    resolveFamilyPlanLevel.mockResolvedValue(level);
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(9999);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: true, monthlyAllowance: null, monthlyUsed: null });
    expect(calls.some((c) => c.table === 'ai_requests'), 'an unlimited plan should not pay for a count').toBe(false);
  });

  it('treats a super-admin as unlimited whatever their family plan', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(9999);
    const access = await assertAIAccess(ctx('daniel.hughen@gmail.com'), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: true, monthlyAllowance: null });
  });
});

describe('the assistant and the concierge are gated separately', () => {
  it('lets a free family reach the assistant', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access.ok).toBe(true);
  });

  it('still refuses a free family the concierge, with the upgrade level', async () => {
    const { assertAIAccess, AI_REQUESTS_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_REQUESTS_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'plan_required', needLevel: 1 });
  });

  // The default has to stay the concierge: every existing caller passes no key.
  it('defaults to the concierge when no feature key is given', async () => {
    const { assertAIAccess } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW });
    expect(access).toMatchObject({ ok: false, code: 'plan_required' });
  });

  it('falls back to the catalog default when the settings read fails', async () => {
    getResolvedFeatureTiers.mockRejectedValue(new Error('settings down'));
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    // 'ai-assistant' defaults to free in the catalog, so a settings outage must
    // not close a door the published plan leaves open.
    expect(access.ok).toBe(true);
  });
});
