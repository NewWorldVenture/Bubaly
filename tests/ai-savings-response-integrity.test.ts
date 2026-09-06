import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  used: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used }) => Promise<unknown>,
  ) => run(mocks),
}));
vi.mock('@/lib/finance/subscriptions', () => ({
  summarizeSubscriptions: () => ({ active: 0, monthlyCents: 0 }),
  wastedMonthlyCents: () => 0,
  isStale: () => false,
  monthlyCostCents: () => 0,
}));

import { POST } from '@/app/api/ai/savings/route';

const fallback = [{
  title: 'On track',
  detail: 'No overspending or unused subscriptions detected. Set category budgets to unlock sharper suggestions.',
}];
const defaultSummary = 'Here are the biggest opportunities to save.';
const unavailableSummary = 'AI is not configured \u2014 here are data-driven suggestions from your finances.';
const validSuggestion = { title: 'Example title', detail: 'Example detail.' };

function reply(summary: unknown, suggestions: unknown) {
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions }), model: 'mock-model' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1' } });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.createServer.mockResolvedValue({
    from: () => {
      const query: Record<string, unknown> = {};
      Object.assign(query, {
        select: () => query,
        eq: () => query,
        gte: () => query,
        neq: () => query,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      });
      return query;
    },
  });
  reply('Example summary.', [validSuggestion]);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('savings endpoint response integrity', () => {
  it.each([
    { label: 'null entries', suggestions: [null] },
    { label: 'primitive entries', suggestions: ['bad', 4, true] },
    { label: 'array entries', suggestions: [[]] },
    { label: 'missing fields', suggestions: [{}, { title: 'Title' }, { detail: 'Detail' }] },
    { label: 'nonstring fields', suggestions: [{ title: 5, detail: 'Detail' }, { title: 'Title', detail: {} }] },
    { label: 'blank fields', suggestions: [{ title: ' \t ', detail: 'Detail' }, { title: 'Title', detail: '\n ' }] },
    { label: 'an empty array', suggestions: [] },
    { label: 'a non-array', suggestions: {} },
  ])('uses the existing fallback for $label', async ({ suggestions }) => {
    reply('Example summary.', suggestions);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'Example summary.', suggestions: fallback, wastedMonthlyCents: 0 });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('keeps valid suggestions in order and applies the four-item limit after removing unusable entries', async () => {
    const valid = Array.from({ length: 5 }, (_, index) => ({ title: ` Title ${index} `, detail: ` Detail ${index} ` }));
    reply('Example summary.', [null, {}, 'bad', { title: ' ', detail: 'Detail' }, ...valid]);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'Example summary.', suggestions: valid.slice(0, 4), wastedMonthlyCents: 0 });
  });

  it.each(['', ' \n\t '])('uses the existing default for a blank summary (%j)', async (summary) => {
    reply(summary, [validSuggestion]);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: defaultSummary, suggestions: [validSuggestion], wastedMonthlyCents: 0 });
  });

  it('preserves valid fenced JSON and the response envelope', async () => {
    const parsed = { summary: 'Example summary.', suggestions: [validSuggestion] };
    mocks.complete.mockResolvedValue({ text: '```json\n' + JSON.stringify(parsed) + '\n```', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...parsed, wastedMonthlyCents: 0 });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ tools: [], maxTokens: 600 }));
  });

  it('preserves the fallback for an empty completion', async () => {
    mocks.complete.mockResolvedValue({ text: '', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: defaultSummary, suggestions: fallback, wastedMonthlyCents: 0 });
  });

  it('preserves the existing unavailable fallback for malformed JSON', async () => {
    mocks.complete.mockResolvedValue({ text: '{bad}', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: unavailableSummary, suggestions: fallback, wastedMonthlyCents: 0 });
  });

  it('preserves the existing unavailable fallback for a rejected provider call', async () => {
    mocks.complete.mockRejectedValue(new Error('Mock provider failure'));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: unavailableSummary, suggestions: fallback, wastedMonthlyCents: 0 });
  });
});
