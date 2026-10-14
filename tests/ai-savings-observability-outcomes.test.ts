import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entitledServiceClient } from './helpers/entitled-service-client';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  used: vi.fn(),
  failed: vi.fn(),
  callbackFailed: vi.fn(),
  isAIConfigured: vi.fn(),
  settled: [] as Array<{ result: unknown; failed: boolean }>,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
// The route resolves the family's plan before it works, through the service
// client (see tests/helpers/entitled-service-client.ts). Seeded as entitled so
// these keep testing what they are named for; the gate itself is covered by
// tests/ai-routes-plan-gate.test.ts.
vi.mock('@/lib/supabase/server', () => ({
  createServer: mocks.createServer,
  createServiceClient: () => entitledServiceClient(),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider, isAIConfigured: mocks.isAIConfigured }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/finance/subscriptions', () => ({
  summarizeSubscriptions: () => ({ active: 0, monthlyCents: 0 }),
  wastedMonthlyCents: () => 0,
  isStale: () => false,
  monthlyCostCents: () => 0,
}));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used; failed: typeof mocks.failed }) => Promise<unknown>,
  ) => {
    try {
      const result = await run({ used: mocks.used, failed: mocks.failed });
      mocks.settled.push({ result, failed: mocks.failed.mock.calls.length > 0 });
      return result;
    } catch (error) {
      mocks.callbackFailed(error);
      throw error;
    }
  },
}));

import { POST } from '@/app/api/ai/savings/route';
import { getMessages, translate } from '@/lib/i18n/messages';

const fallback = [{
  title: 'On track',
  detail: 'No overspending or unused subscriptions detected. Set category budgets to unlock sharper suggestions.',
}];
const defaultSummary = 'Here are the biggest opportunities to save.';
// N15: the AI was asked and could not answer — never "not configured" to a
// family whose AI is configured, and never shown as the AI's own analysis.
const unavailable = { summary: translate(getMessages('en-US'), 'savings.theAiCouldNotAnswerHereAre'), suggestions: fallback, wastedMonthlyCents: 0, source: 'unavailable' };
const validSuggestion = { title: 'Example title', detail: 'Example detail.' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settled.length = 0;
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent' } });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.isAIConfigured.mockResolvedValue(true);
  mocks.complete.mockResolvedValue({ text: '{}', model: 'mock-model' });
  mocks.createServer.mockResolvedValue({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        // `lte`, `gt`, `order` and `limit` so `readAllByIdAsQuery` can page the
        // transactions read on the id, both ends bounded (C1-S9-25,
        // M11-RATCHET). `limit` is the terminal: it resolves to an EMPTY page,
        // which is what tells the reader it has reached the end.
        lte: () => query,
        gt: () => query,
        order: () => query,
        limit: () => Promise.resolve({ data: [], error: null }),
        range: () => Promise.resolve({ data: [], error: null }),
        neq: () => query,
        // The feature-tier read behind the route gate.
        abortSignal: () => query,
        maybeSingle: () => query,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('savings observed outcomes', () => {
  it.each(['', ' \n\t ', '{}', '{"other":"value"}'])('marks unusable output %j failed and says the AI could not answer', async (text) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
    expect(mocks.used).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(mocks.settled).toEqual([{ result: null, failed: true }]);
  });

  it('marks a blank summary and entirely malformed suggestions failed, and does not present the fallback as the AI’s', async () => {
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({ summary: ' ', suggestions: [null, {}, { title: ' ', detail: 'Detail' }] }),
      model: 'mock-model',
    });

    const response = await POST();

    expect(await response.json()).toEqual(unavailable);
    expect(mocks.failed).toHaveBeenCalledOnce();
    expect(mocks.settled[0]?.failed).toBe(true);
  });

  it('records malformed JSON as a failed turn inside the observed callback and says the AI could not answer', async () => {
    mocks.complete.mockResolvedValue({ text: '{bad}', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
    expect(mocks.callbackFailed).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(mocks.settled).toEqual([{ result: null, failed: true }]);
  });

  it('reports a provider failure as the AI being unavailable, not unconfigured', async () => {
    const error = new Error('Mock provider failure');
    mocks.complete.mockRejectedValue(error);

    const response = await POST();

    const body = await response.json();
    expect(body).toEqual(unavailable);
    expect(JSON.stringify(body)).not.toMatch(/not configured/i);
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.settled).toEqual([]);
  });

  it('says the AI is not set up only when it is not, without calling a provider', async () => {
    mocks.isAIConfigured.mockResolvedValue(false);

    const response = await POST();

    expect(await response.json()).toEqual({ summary: translate(getMessages('en-US'), 'savings.aiIsNotSetUpHereAre'), suggestions: fallback, wastedMonthlyCents: 0, source: 'fallback' });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it('keeps an intentional empty suggestion list successful when its summary is useful', async () => {
    const summary = 'No additional opportunities identified.';
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions: [] }), model: 'mock-model' });

    const response = await POST();
    const expected = { summary, suggestions: fallback, wastedMonthlyCents: 0, source: 'ai' };

    expect(await response.json()).toEqual(expected);
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: expected, failed: false }]);
  });

  it.each(['', ' \n ', 42, null])('keeps useful suggestions successful with default summary for %j', async (summary) => {
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions: [validSuggestion] }), model: 'mock-model' });

    const response = await POST();
    const expected = { summary: defaultSummary, suggestions: [validSuggestion], wastedMonthlyCents: 0, source: 'ai' };

    expect(await response.json()).toEqual(expected);
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: expected, failed: false }]);
  });

  it('preserves useful fenced output, original text, ordering, and the four-suggestion limit', async () => {
    const suggestions = Array.from({ length: 5 }, (_, i) => ({ title: ` Title ${i} `, detail: ` Detail ${i} ` }));
    const summary = ' A useful summary. ';
    const content = JSON.stringify({ summary, suggestions });
    mocks.complete.mockResolvedValue({ text: '```json\n' + content + '\n```', model: 'mock-model' });

    const response = await POST();
    const expected = { summary, suggestions: suggestions.slice(0, 4), wastedMonthlyCents: 0, source: 'ai' };

    expect(await response.json()).toEqual(expected);
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: expected, failed: false }]);
  });

  it('records completion text that is not text as a failed turn inside the observed callback', async () => {
    mocks.complete.mockResolvedValue({ text: null, model: 'mock-model' });

    const response = await POST();

    expect(await response.json()).toEqual(unavailable);
    expect(mocks.callbackFailed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: null, failed: true }]);
  });
});
