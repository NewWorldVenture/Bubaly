// `/api/ai/chat` is gated like `/api/ai`, the assistant it duplicates.
//
// `/api/ai/chat` runs the same tool-using assistant as `/api/ai`: a model turn
// that can add events, chores, groceries and reminders. `/api/ai` asks two
// questions before any of that: is the AI Assistant feature on for this
// family's plan (`refuseUnlessEntitled`), and is the family within the monthly
// allowance its plan sells (`assertAIAccess`: ten turns on Free). `/api/ai/chat`
// asked neither. Every signed-in member of every family could call it, up to
// the per-user rate limit (20 a minute), with:
//   - a Free family past its ten turns still answered,
//   - the assistant switched Off, or raised to Basic, by the admin still answered,
//   - a closed family, or one whose trial ended unpaid, still answered.
// The web UI no longer calls it, so nothing on screen shows the gap. The
// route is still deployed and costs a model call per request.
//
// The gates here are the real ones, with the plan seeded through the service
// client `lib/server/plan.ts` reads with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveFeatureTiers, tiersByHref } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

type Family = { trial_ends_at: string | null; closed_at: string | null };
const state: {
  family: Family;
  subscriptions: Array<{ plan: string; status: string }>;
  used: number;
  overrides: Record<string, FeatureTier>;
} = { family: { trial_ends_at: null, closed_at: null }, subscriptions: [], used: 0, overrides: {} };

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
const callerClient = {
  rpc: async (name: string) => {
    countCalls.push(name);
    return { data: state.used, error: null };
  },
  from: (table: string) => { throw new Error(`a refused or unconfigured request must not touch ${table}`); },
};

const isAIConfigured = vi.fn();
const resolveProvider = vi.fn();
const rateLimitDb = vi.fn();

const ctx = {
  user: { id: 'user-1', email: 'parent@example.test' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'UTC' } },
};

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => callerClient,
  createServiceClient: () => serviceClient(),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ctx,
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => resolveFeatureTiers(state.overrides),
  getFeatureTiersByHref: async () => tiersByHref(resolveFeatureTiers(state.overrides)),
}));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: (...a: unknown[]) => rateLimitDb(...a) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: () => isAIConfigured(),
  resolveProvider: () => resolveProvider(),
  describeAIError: (e: unknown) => ({ code: 'x', message: String(e), detail: '' }),
}));

const PAST = '2020-01-01T00:00:00.000Z';

function post() {
  return new NextRequest('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: '22222222-2222-4222-8222-222222222222', message: 'Add soccer practice on Friday' }),
  });
}

async function chat() {
  const { POST } = await import('@/app/api/ai/chat/route');
  return POST(post());
}

beforeEach(() => {
  state.family = { trial_ends_at: null, closed_at: null };
  state.subscriptions = [];
  state.used = 0;
  state.overrides = {};
  countCalls.length = 0;
  // Past the gates, the first thing the route asks. Answering "not configured"
  // stops it there, so a case that reaches it was let through.
  isAIConfigured.mockResolvedValue(false);
  rateLimitDb.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('refused before the model, as /api/ai refuses', () => {
  it('a Free family that has used its ten turns this month', async () => {
    state.used = 10;
    const res = await chat();
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('allowance_exceeded');
    expect(isAIConfigured).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  // A family without the feature is refused before the rate limiter, as on
  // /api/ai, so it does not write a durable rate-limit row per attempt.
  it('the assistant switched Off for the deployment, before the rate limiter', async () => {
    state.overrides = { 'ai-assistant': 'off' };
    const res = await chat();
    expect(res.status).toBe(404);
    expect(rateLimitDb).not.toHaveBeenCalled();
    expect(isAIConfigured).not.toHaveBeenCalled();
  });

  it('a Free family when the admin raised the assistant to Basic, before the rate limiter', async () => {
    state.overrides = { 'ai-assistant': 'basic' };
    const res = await chat();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(rateLimitDb).not.toHaveBeenCalled();
    expect(isAIConfigured).not.toHaveBeenCalled();
  });

  it('a closed family', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    const res = await chat();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('account_closed');
    expect(isAIConfigured).not.toHaveBeenCalled();
  });

  it('a family whose trial ended unpaid', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    const res = await chat();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(isAIConfigured).not.toHaveBeenCalled();
  });
});

describe('let through when /api/ai would let them through', () => {
  it('a Free family under its ten turns, counted once', async () => {
    state.used = 9;
    const res = await chat();
    expect(res.status).toBe(503);
    expect(isAIConfigured).toHaveBeenCalledTimes(1);
    expect(countCalls).toEqual(['count_family_ai_requests_month']);
  });

  it('a paying family, without a count', async () => {
    state.subscriptions = [{ plan: 'basic', status: 'active' }];
    state.used = 500;
    const res = await chat();
    expect(res.status).toBe(503);
    expect(countCalls).toEqual([]);
  });
});
