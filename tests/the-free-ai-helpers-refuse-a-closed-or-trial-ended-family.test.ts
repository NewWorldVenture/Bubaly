// The Free-tier AI helpers refuse a closed or trial-ended family.
//
// Seven routes call a model or a voice provider with no feature gate:
//   - habits, journal, notes, relationship;
//   - voice transcribe and speak (the phone app's microphone);
//   - the public gift page's idea helper.
// Free families may use them; that is the plan. But none asked whether the
// family's account was open. A closed family, or one whose 5-day trial ended
// unpaid, is level 0 like Free, and the only thing in its way was the overlay
// `app/(app)/layout.tsx` draws over the web screens. Calling the route, or
// opening the phone app, which has no overlay, still spent the deployment's
// model and voice keys on an account that is meant to be locked. (The pantry
// chef, the meal planner, nutrition and the two recipe helpers are behind
// `refuseUnlessEntitled` on main now, which refuses a locked family itself.)
//
// Refusal only: none of this meters the routes.
//
// The standing read is the real one (`lib/server/plan.ts`), seeded through the
// service client it reads with. "Reached" means the route got past the gate to
// the first thing that spends: the rate limiter (a durable row per request) or
// the provider.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Family = { trial_ends_at: string | null; closed_at: string | null };
const state: { family: Family; familyReadFails: boolean; superAdmin: boolean } = {
  family: { trial_ends_at: null, closed_at: null }, familyReadFails: false, superAdmin: false,
};

function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'is', 'not', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single', 'abortSignal']) c[m] = () => c;
  c.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return c;
}

const serviceClient = {
  from: (table: string) => chain(() => (
    table === 'families'
      ? (state.familyReadFails ? { data: null, error: { message: 'down' } } : { data: state.family, error: null })
      : table === 'subscriptions' ? { data: [], error: null }
        : table === 'gift_links' ? { data: { id: 'link-1', is_active: true, occasion: 'birthday', child_wallet_id: null, family_id: 'fam-1' }, error: null }
          : { data: [], error: null })),
  rpc: async () => ({ data: null, error: null }),
};
const callerClient = {
  from: () => chain(() => ({ data: [], error: null })),
  rpc: async () => ({ data: null, error: null }),
  auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
};

const ctx = {
  user: { id: 'user-1', email: 'parent@example.test' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-1' }, family: { id: 'fam-1', name: 'Fam', timezone: 'UTC' } },
};

const isAIConfigured = vi.fn();
const resolveProvider = vi.fn();
const enforceAIRateLimit = vi.fn();
const isSuperAdmin = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => callerClient,
  createServiceClient: () => serviceClient,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ctx,
  getUserContext: async () => ctx,
  isSuperAdmin: (...a: unknown[]) => isSuperAdmin(...a),
}));
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  authenticateAI: async () => ({ supabase: callerClient, ctx, via: 'bearer' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: (...a: unknown[]) => enforceAIRateLimit(...a) }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => '203.0.113.7' }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: () => isAIConfigured(),
  resolveProvider: () => resolveProvider(),
  describeAIError: (e: unknown) => ({ code: 'x', message: String(e), detail: '' }),
}));
vi.mock('@/lib/ai/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/settings')>()),
  getOpenAIKey: async () => '',
  getAIConfig: async () => ({}),
}));

type Handler = (req?: NextRequest) => Promise<Response>;
const MEMBER_ROUTES: Array<[string, () => Promise<Handler>]> = [
  ['/api/ai/habits', async () => (await import('@/app/api/ai/habits/route')).POST as Handler],
  ['/api/ai/journal', async () => (await import('@/app/api/ai/journal/route')).POST as Handler],
  ['/api/ai/notes', async () => (await import('@/app/api/ai/notes/route')).POST as Handler],
  ['/api/ai/relationship', async () => (await import('@/app/api/ai/relationship/route')).POST as Handler],
  ['/api/ai/voice/transcribe', async () => (await import('@/app/api/ai/voice/transcribe/route')).POST as Handler],
  ['/api/ai/voice/speak', async () => (await import('@/app/api/ai/voice/speak/route')).POST as Handler],
];

const request = (path: string, body: unknown = {}) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const reached = () => enforceAIRateLimit.mock.calls.length + resolveProvider.mock.calls.length > 0;

const PAST = '2020-01-01T00:00:00.000Z';

// The first import of a route pulls in every translation catalogue, which can
// take most of a case's 20s budget on a loaded machine. It is paid here, once,
// with its own budget, so no case times out on an import.
beforeAll(async () => {
  for (const [, load] of MEMBER_ROUTES) await load();
  await import('@/app/api/ai/gift/route');
}, 120_000);

beforeEach(() => {
  state.family = { trial_ends_at: null, closed_at: null };
  state.familyReadFails = false;
  state.superAdmin = false;
  isAIConfigured.mockResolvedValue(true);
  resolveProvider.mockRejectedValue(new Error('the provider was reached'));
  enforceAIRateLimit.mockResolvedValue({ ok: false, retryAfter: 60 });
  isSuperAdmin.mockResolvedValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe.each(MEMBER_ROUTES)('%s', (path, load) => {
  it('refuses a closed family before any work', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    const res = await (await load())(request(path));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('account_closed');
    expect(reached(), 'the route went on to its work').toBe(false);
  });

  it('refuses a trial-ended family before any work, asking for a plan', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    const res = await (await load())(request(path));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'trial_expired', needLevel: 1 });
    expect(reached(), 'the route went on to its work').toBe(false);
  });

  it('lets an open Free family through to its work', async () => {
    const res = await (await load())(request(path));
    expect(res.status).not.toBe(403);
    expect(reached(), 'the open family never reached the route\'s work').toBe(true);
  });
});

describe('the shared gate', () => {
  it('lets a super administrator through on a closed family', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    isSuperAdmin.mockResolvedValue(true);
    const { POST } = await import('@/app/api/ai/habits/route');
    const res = await POST();
    expect(res.status).not.toBe(403);
    expect(reached()).toBe(true);
  });

  it('answers 503 when the family cannot be read, and does no work', async () => {
    state.familyReadFails = true;
    const { POST } = await import('@/app/api/ai/notes/route');
    const res = await POST(request('/api/ai/notes'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('unavailable');
    expect(reached()).toBe(false);
  });
});

describe('/api/ai/gift, the public gift page', () => {
  async function gift() {
    const { POST } = await import('@/app/api/ai/gift/route');
    return POST(request('/api/ai/gift', { token: 'gift-token', relationship: 'aunt' }));
  }

  it('does not draft ideas for a closed family\'s link', async () => {
    state.family = { trial_ends_at: null, closed_at: PAST };
    const res = await gift();
    expect(res.status).toBe(403);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('does not draft ideas for a trial-ended family\'s link', async () => {
    state.family = { trial_ends_at: PAST, closed_at: null };
    const res = await gift();
    expect(res.status).toBe(403);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('answers 503 when the family cannot be read', async () => {
    state.familyReadFails = true;
    const res = await gift();
    expect(res.status).toBe(503);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('drafts ideas for an open family\'s link', async () => {
    await gift();
    expect(resolveProvider).toHaveBeenCalledTimes(1);
  });
});
