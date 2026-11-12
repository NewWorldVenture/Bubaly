// POST /api/social/ai (API-E2E956FFD1B3), end to end: the real handler, the
// real getUserContext and getSocialAccess over an in-memory database seeded
// with two households, the real feature gate, rate limiter, AI allowance and
// request recorder. Only the model is a fixture.
//
// Already proven elsewhere and not repeated here:
//   tests/user-requested-ai-outside-api-ai-is-metered.test.ts — the allowance
//     is checked before the model, in the source;
//   tests/ai-observability-coverage.test.ts — the generation is recorded under
//     `social.<kind>`;
//   tests/provider-request-body-boundaries.test.ts — the body is read bounded.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { HOUSEHOLD_A, HOUSEHOLD_B, USER_B, seedTwoHouseholds, userA, type HouseholdPlan } from './helpers/two-households-every-role';
import type { MemberRole } from '@/lib/constants/roles';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'fixture-model', complete: h.complete }),
}));

const { POST } = await import('@/app/api/social/ai/route');

const INTERNAL = 'upstream 500 internal detail sk-fixture-0000';
const WRITES = ['social_ai_generations', 'social_usage_events', 'ai_requests', 'rate_limits'] as const;

let db: InMemorySupabase;
let clock = Date.parse('2026-10-14T00:00:00.000Z');

function signIn(userId: string | null, plan: HouseholdPlan = 'basic') {
  db = createInMemorySupabase({
    userId,
    rpc: {
      rate_limit_hit: rateLimitHit,
      is_super_admin: () => false,
      count_family_ai_requests_month: (args, mem) => mem.table('ai_requests').filter((r) => r.family_id === args.p_family_id).length,
    },
  });
  seedTwoHouseholds(db, plan);
  h.db = db;
}

const generate = (body: Record<string, unknown> = { kind: 'caption', topic: 'Our garden in October', platform: 'instagram', tone: 'warm' }) =>
  POST(new NextRequest('http://localhost/api/social/ai', { method: 'POST', body: JSON.stringify(body) }));

function expectNothingWritten() {
  for (const table of WRITES) expect(db.table(table), table).toEqual([]);
  expect(h.complete).not.toHaveBeenCalled();
}

beforeEach(() => {
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  h.complete.mockReset().mockResolvedValue({ text: '  Autumn in the garden.  ', usage: { input_tokens: 10, output_tokens: 10 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('API-E2E956FFD1B3 POST /api/social/ai', () => {
  it('API-E2E956FFD1B3 refuses a signed-out caller with 401 and writes nothing', async () => {
    signIn(null);

    const response = await generate();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'ai.unauthorized' });
    expectNothingWritten();
  });

  it.each(['parent', 'adult', 'teen'] as MemberRole[])('API-E2E956FFD1B3 a household-A %s (a social role with generate_ai) gets the draft, recorded once under household A', async (role) => {
    signIn(userA(role));

    const response = await generate();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Autumn in the garden.', model: 'fixture-model', kind: 'caption' });
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(db.table('social_ai_generations')).toHaveLength(1);
    expect(db.table('social_ai_generations')[0]).toMatchObject({
      family_id: HOUSEHOLD_A, user_id: userA(role), created_by: userA(role), kind: 'caption', platform: 'instagram',
      prompt: 'Our garden in October', input: { tone: 'warm', hasSource: false }, output: { text: 'Autumn in the garden.' },
      model: 'fixture-model', status: 'succeeded',
    });
    expect(db.table('social_usage_events')).toHaveLength(1);
    expect(db.table('social_usage_events')[0]).toMatchObject({ family_id: HOUSEHOLD_A, user_id: userA(role), kind: 'ai_generation', quantity: 1 });
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(db.table('ai_requests')[0]).toMatchObject({ family_id: HOUSEHOLD_A, requested_by: userA(role) });
  });

  it.each(['child', 'caregiver', 'guest'] as MemberRole[])('API-E2E956FFD1B3 a household-A %s (read_only by default) is refused 403 with nothing written and no model call', async (role) => {
    signIn(userA(role));

    const response = await generate();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ai.youDoNotHavePermission' });
    expectNothingWritten();
  });

  it('API-E2E956FFD1B3 an explicit social role lifts a household-A child to content_creator', async () => {
    signIn(userA('child'));
    db.seed('social_access_permissions', [{ family_id: HOUSEHOLD_A, user_id: userA('child'), social_role: 'content_creator', status: 'active' }]);

    expect((await generate()).status).toBe(200);
    expect(db.table('social_ai_generations').map((row) => row.user_id)).toEqual([userA('child')]);
  });

  it('API-E2E956FFD1B3 an explicit analyst role refuses a household-A parent', async () => {
    signIn(userA('parent'));
    db.seed('social_access_permissions', [{ family_id: HOUSEHOLD_A, user_id: userA('parent'), social_role: 'analyst', status: 'active' }]);

    expect((await generate()).status).toBe(403);
    expectNothingWritten();
  });

  it('API-E2E956FFD1B3 a social role held in household B does not lift a household-A child, and a family id in the body is ignored', async () => {
    signIn(userA('child'));
    db.seed('social_access_permissions', [{ family_id: HOUSEHOLD_B, user_id: userA('child'), social_role: 'owner', status: 'active' }]);

    const refused = await generate({ kind: 'caption', topic: 'x', familyId: HOUSEHOLD_B });
    expect(refused.status).toBe(403);
    expectNothingWritten();

    signIn(USER_B);
    const response = await generate({ kind: 'ideas', topic: 'Winter', familyId: HOUSEHOLD_A });
    expect(response.status).toBe(200);
    expect(db.table('social_ai_generations').map((row) => row.family_id)).toEqual([HOUSEHOLD_B]);
    expect(db.table('social_usage_events').map((row) => row.family_id)).toEqual([HOUSEHOLD_B]);
  });

  it('API-E2E956FFD1B3 a Free household A is refused by the Social Circle plan gate (Family Basic) before the limiter and the model', async () => {
    signIn(userA('parent'), 'free');

    const response = await generate();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expectNothingWritten();
  });

  it('API-E2E956FFD1B3 the twenty-first draft in a minute is refused 429 with no model call', async () => {
    signIn(userA('adult'));
    for (let i = 0; i < 20; i += 1) expect((await generate()).status).toBe(200);
    h.complete.mockClear();

    const response = await generate();

    expect(response.status).toBe(429);
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('social_ai_generations')).toHaveLength(20);
  });

  it('API-E2E956FFD1B3 a model that fails is 503 with a fixed sentence, recorded as a failed generation and not counted as usage', async () => {
    signIn(userA('parent'));
    h.complete.mockRejectedValue(new Error(INTERNAL));

    const response = await generate();

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Something went wrong while answering. Please try again.' });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('social_ai_generations')).toHaveLength(1);
    expect(db.table('social_ai_generations')[0]).toMatchObject({ family_id: HOUSEHOLD_A, status: 'failed', output: { error: 'Something went wrong while answering. Please try again.' } });
    expect(JSON.stringify(db.table('social_ai_generations'))).not.toContain(INTERNAL);
    expect(db.table('social_usage_events')).toEqual([]);
  });

  it('API-E2E956FFD1B3 a social role that cannot be read is never a success, and reaches no model', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table) => (table === 'social_access_permissions' ? { message: INTERNAL } : null));

    // getSocialAccess throws SocialAccessUnavailableError, which the route
    // does not catch today (the PR's owner-decision note): whatever the answer
    // becomes, it is not a 200 and nothing is spent.
    const outcome = await generate().then((response) => response.status, () => 'rejected');

    expect(outcome).not.toBe(200);
    expectNothingWritten();
  });
});
