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

/** The count-only transport. A raw private-row read fails the test. */
function db(count: unknown, error: unknown = null) {
  const calls: { table: string; filters: Array<[string, unknown]> }[] = [];
  return { client: {
    from: () => { throw new Error('Quota must not read private request rows'); },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ table: name, filters: Object.entries(args) });
      return { data: count, error };
    },
  } as never, calls };
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
    const query = calls.find((c) => c.table === 'count_family_ai_requests_month');
    expect(query, 'no protected household count was issued').toBeTruthy();
    const columns = query!.filters.map(([c]) => c);
    expect(columns).toContain('p_family_id');
    expect(columns).toContain('p_month_start');
    expect(columns, 'a kind filter would exclude every assistant turn').not.toContain('kind');
  });

  it('counts from the start of the UTC month', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(1);
    await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    const since = calls.find((c) => c.table === 'count_family_ai_requests_month')!.filters.find(([c]) => c === 'p_month_start')![1];
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
    expect(calls, 'an unlimited plan should not pay for a count').toEqual([]);
  });

  it('treats a super-admin as unlimited whatever their family plan', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(9999);
    const access = await assertAIAccess(ctx('daniel.hughen@gmail.com'), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: true, monthlyAllowance: null });
  });
});

describe('private requests keep household quota enforceable', () => {
  it('denies a child when siblings and system requests exhausted the household allowance', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(11);
    const child = { user: { id: 'child-user', email: 'child@example.test' }, memberships: [],
      active: { familyId: 'fam-1', role: 'child', family: { name: 'Fam' } } } as never;
    expect(await assertAIAccess(child, { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 429, code: 'allowance_exceeded' });
    expect(calls[0].filters).toContainEqual(['p_family_id', 'fam-1']);
  });

  it.each([null, undefined, '0', {}, [], -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('fails closed on an invalid count receipt (%j)', async receipt => {
      const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
      expect(await assertAIAccess(ctx(), { db: db(receipt).client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
        .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
    });

  it('fails closed when the unapplied RPC is missing', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    expect(await assertAIAccess(ctx(), { db: db(null, { code: 'PGRST202', message: 'RPC missing' }).client,
      now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY })).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('fails closed on a rejected transport without a private-row fallback', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const client = { rpc: async () => { throw new Error('Synthetic count transport failure'); },
      from: () => { throw new Error('Forbidden private-row fallback'); } } as never;
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, code: 'unavailable' });
  });

  it.each([
    ['2026-10-31T23:59:59-04:00', '2026-11-01T00:00:00.000Z'],
    ['2028-02-29T12:00:00Z', '2028-02-01T00:00:00.000Z'],
  ])('keeps the UTC month boundary at %s', async (at, expected) => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(0);
    await assertAIAccess(ctx(), { db: client, now: new Date(at), featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(calls[0].filters).toContainEqual(['p_month_start', expected]);
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

  it('reads the tiers for an access decision, so a failed read is not answered with defaults', async () => {
    const { assertAIAccess } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    await assertAIAccess(ctx(), { db: client, now: NOW });
    expect(getResolvedFeatureTiers).toHaveBeenCalledWith(client, { onUnavailable: 'throw' });
  });

  it('answers "could not confirm" when the settings read fails, never the catalog default', async () => {
    // It used to fall back to the catalog default ('ai-assistant' is free
    // there). But an admin can make a feature stricter than its default, and
    // the default would then grant it on a failed lookup. The answer is the
    // one an unreadable plan gets.
    getResolvedFeatureTiers.mockRejectedValue(new Error('settings down'));
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('still lets a super administrator through when the settings read fails', async () => {
    // A super administrator passes every tier, so the tier decides nothing.
    vi.stubEnv('SUPER_ADMIN_EMAILS', 'operator@example.test');
    getResolvedFeatureTiers.mockRejectedValue(new Error('settings down'));
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = db(0);
    const access = await assertAIAccess(ctx('operator@example.test'), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access.ok).toBe(true);
    vi.unstubAllEnvs();
  });
});
