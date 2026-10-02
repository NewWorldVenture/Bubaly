import { beforeEach, describe, expect, it, vi } from 'vitest';

// F19, #771 review 5392003945: the marketplace assistant meters only its model
// call. A Free family past its month still gets the grounded answer built from
// its own listings — no provider call — exactly as a family with no AI key
// does. The real action, real allowance helper and real grounded engine run;
// the database, provider and request store are in-memory fakes.

const state = vi.hoisted(() => ({
  used: 0,
  providerCalls: 0,
  rows: 0,
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};

const LISTINGS = [
  { id: 'l-1', title: 'Kids bike', kind: 'sell', category: 'sports', condition: 'good', price_cents: 4500, rent_period: null, status: 'active', member_id: 'member-2' },
];

function db() {
  return {
    from(table: string) {
      if (table === 'ai_requests') {
        return {
          select: () => ({ eq: () => ({ gte: async () => ({ count: state.used, error: null }) }) }),
        };
      }
      const rows = table === 'marketplace_listings' ? LISTINGS : [];
      const chain = { select: () => chain, eq: () => chain, limit: async () => ({ data: rows, error: null }) };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db() }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 0,
}));
vi.mock('@/lib/i18n/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/i18n/server')>();
  return {
    ...real,
    getTranslations: async () => (key: string) => key,
    getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  };
});
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    model: 'test-model',
    complete: async () => { state.providerCalls += 1; return { text: 'The bike is $45.', usage: null }; },
  }),
}));
vi.mock('@/lib/ai/runs/store', () => ({
  createRequest: async () => { state.rows += 1; return { ok: true, data: { id: `req-${state.rows}` } }; },
  updateRequest: async () => ({ ok: true, data: null }),
}));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => {} }));

beforeEach(() => { state.used = 0; state.providerCalls = 0; state.rows = 0; });

describe('the marketplace assistant meters only its model call', () => {
  it('a Free family past its month gets the grounded answer, with no provider call and no request filed', async () => {
    const { askMarketAssistantAction } = await import('@/app/(app)/marketplace/assistant-actions');
    state.used = 10;
    const res = await askMarketAssistantAction('How much is the bike?');
    expect(res).toMatchObject({ ok: true, source: 'engine' });
    expect((res as { reply: string }).reply.length).toBeGreaterThan(0);
    expect(state.providerCalls).toBe(0);
    expect(state.rows).toBe(0);
  });

  it('control: under the allowance the model answers and the request is filed', async () => {
    const { askMarketAssistantAction } = await import('@/app/(app)/marketplace/assistant-actions');
    state.used = 3;
    const res = await askMarketAssistantAction('How much is the bike?');
    expect(res).toMatchObject({ ok: true, source: 'llm', reply: 'The bike is $45.' });
    expect(state.providerCalls).toBe(1);
    expect(state.rows).toBe(1);
  });
});
