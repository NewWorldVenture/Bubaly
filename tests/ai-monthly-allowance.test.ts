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

vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: (...a: unknown[]) => resolveFamilyPlanLevel(...a),
  resolveFamilyEntitlement: async (...a: unknown[]) => ({ effectiveLevel: await (resolveFamilyPlanLevel(...a)), locked: false, closed: false, inTrial: false, trialEndsAt: null }),
}));
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

  // Review on #788: a response with no error AND no count is a meter that did
  // not answer, not a count of zero. Read as zero, it let a family that had
  // spent its month call the model again.
  it('fails closed when the read succeeds but carries no count', async () => {
    const { assertAIAccess, assertFamilyAIAllowance, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const access = await assertAIAccess(ctx(), { db: db(null).client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'unavailable' });
    const family = await assertFamilyAIAllowance(db(null).client, 'fam-1');
    expect(family).toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('a real count of zero is still allowed', async () => {
    const { assertFamilyAIAllowance } = await import('@/lib/server/ai-access');
    expect(await assertFamilyAIAllowance(db(0).client, 'fam-1')).toMatchObject({ ok: true, monthlyUsed: 0 });
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

  // A PGRST202 that does not name the quota function is not "0493 is missing":
  // it is some other failure and still fails closed, with no row read.
  it('fails closed on a missing-function answer that does not name the quota RPC', async () => {
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

// Production has not taken held migration 0493, so `count_family_ai_requests_month`
// does not exist there. Until it does, the allowance is counted exactly as the
// previous release counted it: a direct exact, head-only `ai_requests` count
// from the start of the UTC month. Only the missing-function answer naming this
// RPC switches to that path; every other RPC failure still fails closed.
describe('without held migration 0493, the previous direct count keeps the allowance', () => {
  const MISSING_PGRST202 = {
    code: 'PGRST202',
    message: 'Could not find the function public.count_family_ai_requests_month(p_family_id, p_month_start) in the schema cache',
    details: 'Searched for the function public.count_family_ai_requests_month with parameters p_family_id, p_month_start or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.',
    hint: null,
  };
  const MISSING_42883 = {
    code: '42883',
    message: 'function public.count_family_ai_requests_month(uuid, timestamp with time zone) does not exist',
    details: null,
    hint: 'No function matches the given name and argument types. You might need to add explicit type casts.',
  };

  type LegacyQuery = { table: string; select?: [string, unknown]; filters: Array<[string, string, unknown]> };

  /** RPC answers `rpcError`; the table read answers `{ count, error }` like a head count. */
  function legacyDb(rpcError: unknown, legacy: { count: number | null; error: unknown; rejects?: unknown }) {
    const rpcCalls: string[] = [];
    const queries: LegacyQuery[] = [];
    const client = {
      rpc: async (name: string) => { rpcCalls.push(name); return { data: null, error: rpcError }; },
      from: (table: string) => {
        const q: LegacyQuery = { table, filters: [] };
        queries.push(q);
        const builder = {
          select: (cols: string, opts: unknown) => { q.select = [cols, opts]; return builder; },
          eq: (col: string, val: unknown) => { q.filters.push(['eq', col, val]); return builder; },
          gte: (col: string, val: unknown) => { q.filters.push(['gte', col, val]); return builder; },
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            ('rejects' in legacy
              ? Promise.reject(legacy.rejects)
              : Promise.resolve({ data: null, count: legacy.count, error: legacy.error })).then(resolve, reject),
        };
        return builder;
      },
    } as never;
    return { client, rpcCalls, queries };
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { resetMonthlyCountFallbackWarning } = await import('@/lib/server/ai-access');
    resetMonthlyCountFallbackWarning();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([['PGRST202', MISSING_PGRST202], ['42883', MISSING_42883]])
    ('allows a request under the allowance using the previous count (%s)', async (_code, missing) => {
      const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
      const { client, rpcCalls, queries } = legacyDb(missing, { count: 3, error: null });
      const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
      expect(access).toMatchObject({ ok: true, planLevel: 0, monthlyUsed: 3, monthlyAllowance: 10 });
      expect(rpcCalls).toEqual(['count_family_ai_requests_month']);
      expect(queries).toEqual([{
        table: 'ai_requests',
        select: ['id', { count: 'exact', head: true }],
        filters: [['eq', 'family_id', 'fam-1'], ['gte', 'created_at', '2026-09-01T00:00:00.000Z']],
      }]);
    });

  it('allows the last request just under the allowance when counting the previous way', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY, AI_MONTHLY_ALLOWANCE } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_42883, { count: AI_MONTHLY_ALLOWANCE[0]! - 1, error: null });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: true, monthlyUsed: AI_MONTHLY_ALLOWANCE[0]! - 1 });
  });

  it('refuses at the allowance with the same 429 when counting the previous way', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY, AI_MONTHLY_ALLOWANCE } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_PGRST202, { count: AI_MONTHLY_ALLOWANCE[0]!, error: null });
    const access = await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 429, code: 'allowance_exceeded' });
  });

  // A head count that answers no error and no count (supabase-js leaves `count`
  // null when the Content-Range header does not come back) is an unread count,
  // not an empty month. Reading it as zero would reopen the whole allowance;
  // the RPC path already refuses a null receipt.
  it.each([['PGRST202', MISSING_PGRST202], ['42883', MISSING_42883]])
    ('fails closed when the previous count answers no count and no error (%s)', async (_code, missing) => {
      const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
      const { client, queries } = legacyDb(missing, { count: null, error: null });
      expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
        .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
      expect(queries).toHaveLength(1);
    });

  it.each([NaN, -1, 0.5])('fails closed on an invalid previous count (%s)', async (bad) => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_PGRST202, { count: bad, error: null });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('fails closed when the previous count errors even if it also reports a count', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_42883, { count: 0, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('allows a zero previous count, which is a real empty month', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_PGRST202, { count: 0, error: null });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: true, monthlyUsed: 0, monthlyAllowance: 10 });
  });

  it('fails closed when the previous count itself errors', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_PGRST202, { count: null, error: { code: '42501', message: 'permission denied for table ai_requests' } });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('fails closed when the previous count query rejects', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client } = legacyDb(MISSING_PGRST202, { count: null, error: null, rejects: new TypeError('fetch failed') });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
  });

  it('warns once per process, naming the held migration', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    for (let i = 0; i < 3; i++) {
      const { client } = legacyDb(MISSING_PGRST202, { count: 1, error: null });
      await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0493_ai_copy_private_read_and_quota.sql');
    expect(String(warn.mock.calls[0][0])).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it.each([
    ['permission', { code: '42501', message: 'permission denied for function count_family_ai_requests_month' }],
    ['network', { code: '', message: 'TypeError: fetch failed' }],
    ['other function missing', { code: '42883', message: 'function public.is_family_member(uuid) does not exist' }],
    ['longer function name', { code: 'PGRST202', message: 'Could not find the function public.count_family_ai_requests_month_v2 in the schema cache' }],
    ['missing-table code', { code: 'PGRST205', message: "Could not find the table 'public.count_family_ai_requests_month' in the schema cache" }],
  ])('still fails closed without a direct read on a %s error', async (_label, rpcError) => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, queries } = legacyDb(rpcError, { count: 0, error: null });
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: false, status: 403, code: 'unavailable' });
    expect(queries).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the RPC unchanged once 0493 is applied', async () => {
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const { client, calls } = db(4);
    expect(await assertAIAccess(ctx(), { db: client, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY }))
      .toMatchObject({ ok: true, monthlyUsed: 4, monthlyAllowance: 10 });
    expect(calls).toEqual([{ table: 'count_family_ai_requests_month',
      filters: [['p_family_id', 'fam-1'], ['p_month_start', '2026-09-01T00:00:00.000Z']] }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
