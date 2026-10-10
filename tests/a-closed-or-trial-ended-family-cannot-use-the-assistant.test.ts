// A closed family, or one whose free trial ended unpaid, cannot use the assistant.
//
// `computeEntitlement` gives both of them effective level 0, the same number a
// Free family has, and adds `closed` / `locked` beside it. `assertAIAccess`
// read only the number. The AI Assistant is a Free-tier feature (ten turns a
// month), so a closed family and a trial-ended one both passed the gate and got
// those turns, with the assistant's tools writing into an account that is meant
// to be locked.
//
// Nothing else stopped them. `AccountClosedGate` and `TrialPaywallGate` are
// rendered by `app/(app)/layout.tsx`: they hide the web screens and nothing
// more. `/api/ai` answers the phone app over a bearer token, and the phone app
// has no paywall, so on the phone a closed or trial-ended family simply kept
// going.
//
// The plan read is the real one (`lib/server/plan.ts`), seeded through the
// service client it reads with, so these cases exercise the entitlement the
// rest of the app computes rather than a mocked level.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveFeatureTiers, tiersByHref } from '@/lib/features/tiers';

type Family = { trial_ends_at: string | null; closed_at: string | null };
const state: { family: Family; subscriptions: Array<{ plan: string; status: string }>; used: number } = {
  family: { trial_ends_at: null, closed_at: null },
  subscriptions: [],
  used: 0,
};

/** The service client `resolveFamilyPlanLevel` reads the family and its plan through. */
function serviceClient() {
  return {
    from: (table: string) => {
      const result = table === 'families'
        ? { data: state.family, error: null }
        : table === 'subscriptions'
          ? { data: state.subscriptions, error: null }
          : { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'maybeSingle']) chain[m] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  };
}

const countCalls: string[] = [];
/**
 * The caller's own client. The gate asks it only for the protected monthly
 * count; the route past the gate opens the conversation on it.
 */
const callerClient = {
  rpc: async (name: string) => {
    countCalls.push(name);
    return { data: state.used, error: null };
  },
  from: (table: string) => {
    if (table !== 'ai_conversations') throw new Error(`unexpected caller read of ${table}`);
    const chain: Record<string, unknown> = {
      upsert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: { id: 'conversation' }, error: null }),
    };
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    return chain;
  },
};

const getBearerUserContext = vi.fn();
const prepareAssistantTurn = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => callerClient,
  createServiceClient: () => serviceClient(),
}));
vi.mock('@/lib/supabase/auth', () => ({
  getUserContext: async () => null,
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: (token: string) => getBearerUserContext(token),
}));
// The published catalogue, with no admin overrides: the assistant is Free,
// the concierge Basic.
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => resolveFeatureTiers({}),
  getFeatureTiersByHref: async () => tiersByHref(resolveFeatureTiers({})),
}));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  describeAIError: (e: unknown) => ({ code: 'x', message: String(e), detail: '' }),
}));
vi.mock('@/lib/ai/assistant-engine', async (importOriginal) => ({
  wantsJsonTransport: (await importOriginal<typeof import('@/lib/ai/assistant-engine')>()).wantsJsonTransport,
  SSE_HEADERS: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  prepareAssistantTurn: (...a: unknown[]) => prepareAssistantTurn(...a),
  runAssistantTurn: vi.fn(),
  createAssistantStream: vi.fn(),
}));

// The plan read judges the trial against the real clock, so the dates are far
// enough either side of it never to move.
const NOW = new Date('2026-10-09T12:00:00.000Z');
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const ctx = (email = 'parent@example.test') => ({
  user: { id: 'user-1', email },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'UTC' } },
}) as never;

beforeEach(() => {
  state.family = { trial_ends_at: null, closed_at: null };
  state.subscriptions = [];
  state.used = 0;
  countCalls.length = 0;
  getBearerUserContext.mockResolvedValue({ ok: true, supabase: callerClient, ctx: ctx() });
  // The first step past the gate. It answers with a marker, so a case can tell
  // "reached the turn" from every refusal before it.
  prepareAssistantTurn.mockResolvedValue({ ok: false, error: 'reached the turn' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

async function ask(featureKey?: string) {
  const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
  return assertAIAccess(ctx(), { db: callerClient as never, now: NOW, featureKey: featureKey ?? AI_ASSISTANT_FEATURE_KEY });
}

describe('a closed family is refused the assistant', () => {
  it('refuses a closed Free family, and counts nothing', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    const access = await ask();
    expect(access).toMatchObject({ ok: false, status: 403, code: 'account_closed' });
    expect((access as { error: string }).error).toMatch(/closed/i);
    expect(countCalls, 'a closed family has no allowance to count').toEqual([]);
  });

  // Closing stops renewal at the period's end, so the paid row stays active
  // until then. Closed still wins: the family chose to lock the account.
  it('refuses a closed family whose paid plan has not run out yet', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    state.subscriptions = [{ plan: 'plus', status: 'active' }];
    expect(await ask()).toMatchObject({ ok: false, status: 403, code: 'account_closed' });
  });

  it('refuses the concierge as closed, not as a plan to upgrade', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    expect(await ask('ai-requests')).toMatchObject({ ok: false, status: 403, code: 'account_closed' });
  });
});

describe('a family whose trial ended unpaid is refused the assistant', () => {
  it('refuses it as a plan to choose, naming Family Basic, and counts nothing', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    const access = await ask();
    expect(access).toMatchObject({ ok: false, status: 403, code: 'plan_required', needLevel: 1 });
    expect((access as { error: string }).error).toMatch(/trial/i);
    expect(countCalls).toEqual([]);
  });
});

describe('everyone the paywall lets through still gets the assistant', () => {
  it('a grandfathered Free family (no trial date) keeps its ten turns', async () => {
    state.used = 3;
    expect(await ask()).toMatchObject({ ok: true, planLevel: 0, monthlyUsed: 3, monthlyAllowance: 10 });
  });

  it('a family inside its trial has Family Basic', async () => {
    state.family = { trial_ends_at: FUTURE, closed_at: null };
    expect(await ask()).toMatchObject({ ok: true, planLevel: 1, monthlyAllowance: null });
  });

  it('a family that paid after its trial ended has its plan', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    state.subscriptions = [{ plan: 'basic', status: 'active' }];
    expect(await ask()).toMatchObject({ ok: true, planLevel: 1 });
  });

  it('a super administrator is never locked out by their own family', async () => {
    state.family = { trial_ends_at: PAST, closed_at: PAST };
    const { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } = await import('@/lib/server/ai-access');
    const access = await assertAIAccess(ctx('daniel.hughen@gmail.com'), { db: callerClient as never, now: NOW, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: true, planLevel: 2 });
  });
});

describe('the phone app, which has no paywall, is refused at /api/ai', () => {
  const CONVERSATION = '22222222-2222-4222-8222-222222222222';
  const post = () => new NextRequest('http://localhost/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer phone-token' },
    body: JSON.stringify({ conversationId: CONVERSATION, message: 'Add soccer practice on Friday' }),
  });

  it('answers a closed family 403 before any turn is prepared', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('account_closed');
    expect(prepareAssistantTurn).not.toHaveBeenCalled();
  });

  it('answers a trial-ended family 403 before any turn is prepared', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(prepareAssistantTurn).not.toHaveBeenCalled();
  });

  it('still lets a grandfathered Free family through to the turn', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post());
    expect(await res.json()).toEqual({ error: 'reached the turn' });
    expect(prepareAssistantTurn).toHaveBeenCalledTimes(1);
  });
});
