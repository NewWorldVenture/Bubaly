import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F19 / I18N, on the social generator (/api/social/ai), from the #892 review:
//
//   • The route files through `generate` (lib/social/ai), not `withAiRequest`
//     directly, so the admission ratchet never saw it. When the admission
//     (0477) refused the last slot to a parallel request, the catch answered
//     503 "temporarily unavailable" in English AND logged a failed
//     `social_ai_generations` row for a generation that never ran.
//   • `refuseOverAIAllowance` translated only `allowance_exceeded`; a plan it
//     could not read ("could not confirm your plan") went out in English.
//
// Drives the REAL route, the real `refuseOverAIAllowance` / `admissionRefusalResponse`
// and the real German catalogue. Identity, social access, the entitlement gate,
// the rate limit and the generator are fixed.

const state = vi.hoisted(() => ({
  used: 3,
  planFails: false,
  generate: 'ok' as 'ok' | 'admission' | 'outage',
  inserts: [] as Array<Record<string, unknown>>,
  generated: 0,
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};
function client() {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, gte: () => chain,
    insert: async (row: Record<string, unknown>) => { state.inserts.push(row); return { error: null }; },
    then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null, count: state.used }),
  };
  return { from: () => chain };
}

vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('de-DE' as never), key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx, getUserContext: async () => ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client(), createServiceClient: () => client() }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/social/access', () => ({ getSocialAccess: async () => ({ can: () => true }) }));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => { if (state.planFails) throw new Error('plan read failed'); return 0; },
}));
vi.mock('@/lib/social/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/social/ai')>();
  const { AiRequestOverAllowance } = await import('@/lib/ai/observability');
  return {
    ...real,
    generate: async () => {
      if (state.generate === 'admission') throw new AiRequestOverAllowance('social.caption', 10);
      if (state.generate === 'outage') throw new Error('provider down');
      state.generated += 1;
      return { text: 'Ein Beitrag.', model: 'test' };
    },
  };
});

vi.setConfig({ testTimeout: 20_000 });

const GERMAN_ALLOWANCE = 'Ihre Familie hat ihre 10 KI-Anfragen für diesen Monat aufgebraucht. Wechseln Sie zu Family Basic für unbegrenzte Anfragen oder versuchen Sie es nächsten Monat erneut.';
const GERMAN_PLAN_UNREADABLE = 'Bubaly konnte Ihren Tarif gerade nicht bestätigen. Versuchen Sie es gleich noch einmal.';

const post = async () => {
  const { POST } = await import('@/app/api/social/ai/route');
  return POST(new Request('http://localhost/api/social/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'caption', topic: 'Sommerfest' }),
  }));
};
const failedRows = () => state.inserts.filter((r) => r.status === 'failed');

beforeEach(() => {
  state.used = 3;
  state.planFails = false;
  state.generate = 'ok';
  state.inserts = [];
  state.generated = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the social generator and the admission refusal (F19 race)', () => {
  it('the admission refusing the last slot is the allowance (429, German), and no failed generation is logged', async () => {
    state.used = 9;
    state.generate = 'admission';
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'allowance_exceeded', limit: 10, error: GERMAN_ALLOWANCE });
    expect(failedRows()).toEqual([]);
  });

  it('control: a provider outage is still a 503 and is still logged as failed', async () => {
    state.generate = 'outage';
    const res = await post();
    expect(res.status).toBe(503);
    expect(failedRows()).toHaveLength(1);
  });

  it('control: under the cap the post is generated and logged as succeeded', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.generated).toBe(1);
    expect(state.inserts.filter((r) => r.status).map((r) => r.status)).toEqual(['succeeded']);
  });
});

describe('refuseOverAIAllowance speaks every refusal in the reader\'s language', () => {
  it('at the gate (10 of 10): the allowance in German', async () => {
    state.used = 10;
    const res = await post();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(GERMAN_ALLOWANCE);
    expect(state.generated).toBe(0);
  });

  it('a plan it cannot read: "could not confirm your plan" in German, not English', async () => {
    state.planFails = true;
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'unavailable', error: GERMAN_PLAN_UNREADABLE });
    expect(state.generated).toBe(0);
  });
});
