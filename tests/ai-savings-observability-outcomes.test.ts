import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  used: vi.fn(),
  failed: vi.fn(),
  callbackFailed: vi.fn(),
  settled: [] as Array<{ result: unknown; failed: boolean }>,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider }));
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

const fallback = [{
  title: 'On track',
  detail: 'No overspending or unused subscriptions detected. Set category budgets to unlock sharper suggestions.',
}];
const defaultSummary = 'Here are the biggest opportunities to save.';
const unavailableSummary = 'AI is not configured \u2014 here are data-driven suggestions from your finances.';
const validSuggestion = { title: 'Example title', detail: 'Example detail.' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settled.length = 0;
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1' } });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.complete.mockResolvedValue({ text: '{}', model: 'mock-model' });
  mocks.createServer.mockResolvedValue({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        neq: () => query,
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
  it.each(['', ' \n\t ', '{}', '{"other":"value"}'])('marks unusable output %j failed before settling', async (text) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST();
    const expected = { summary: defaultSummary, suggestions: fallback, wastedMonthlyCents: 0 };

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(mocks.used).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(mocks.settled).toEqual([{ result: expected, failed: true }]);
  });

  it('marks a blank summary and entirely malformed suggestions failed without changing fallback content', async () => {
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({ summary: ' ', suggestions: [null, {}, { title: ' ', detail: 'Detail' }] }),
      model: 'mock-model',
    });

    const response = await POST();

    expect(await response.json()).toEqual({ summary: defaultSummary, suggestions: fallback, wastedMonthlyCents: 0 });
    expect(mocks.failed).toHaveBeenCalledOnce();
    expect(mocks.settled[0]?.failed).toBe(true);
  });

  it('keeps malformed JSON inside the observed callback while preserving the unavailable fallback', async () => {
    mocks.complete.mockResolvedValue({ text: '{bad}', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: unavailableSummary, suggestions: fallback, wastedMonthlyCents: 0 });
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(expect.any(SyntaxError));
    expect(mocks.settled).toEqual([]);
  });

  it('preserves provider failures and the existing fallback', async () => {
    const error = new Error('Mock provider failure');
    mocks.complete.mockRejectedValue(error);

    const response = await POST();

    expect(await response.json()).toEqual({ summary: unavailableSummary, suggestions: fallback, wastedMonthlyCents: 0 });
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.settled).toEqual([]);
  });

  it('keeps an intentional empty suggestion list successful when its summary is useful', async () => {
    const summary = 'No additional opportunities identified.';
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions: [] }), model: 'mock-model' });

    const response = await POST();
    const expected = { summary, suggestions: fallback, wastedMonthlyCents: 0 };

    expect(await response.json()).toEqual(expected);
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: expected, failed: false }]);
  });

  it.each(['', ' \n ', 42, null])('keeps useful suggestions successful with default summary for %j', async (summary) => {
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions: [validSuggestion] }), model: 'mock-model' });

    const response = await POST();
    const expected = { summary: defaultSummary, suggestions: [validSuggestion], wastedMonthlyCents: 0 };

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
    const expected = { summary, suggestions: suggestions.slice(0, 4), wastedMonthlyCents: 0 };

    expect(await response.json()).toEqual(expected);
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ result: expected, failed: false }]);
  });

  it('keeps malformed completion text inside the observed callback', async () => {
    mocks.complete.mockResolvedValue({ text: null, model: 'mock-model' });

    const response = await POST();

    expect(await response.json()).toEqual({ summary: unavailableSummary, suggestions: fallback, wastedMonthlyCents: 0 });
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(expect.any(TypeError));
    expect(mocks.settled).toEqual([]);
  });
});
