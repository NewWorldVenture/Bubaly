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
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider, isAIConfigured: async () => true }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used; failed: typeof mocks.failed }) => Promise<unknown>,
  ) => run(mocks),
}));
vi.mock('@/lib/finance/subscriptions', () => ({
  summarizeSubscriptions: () => ({ active: 0, monthlyCents: 0 }),
  wastedMonthlyCents: () => 0,
  isStale: () => false,
  monthlyCostCents: () => 0,
}));

import { POST } from '@/app/api/ai/savings/route';
import { getMessages, translate } from '@/lib/i18n/messages';

const fallback = [{
  title: 'On track',
  detail: 'No overspending or unused subscriptions detected. Set category budgets to unlock sharper suggestions.',
}];
const defaultSummary = 'Here are the biggest opportunities to save.';
// The AI was asked and could not answer (N15): said so, in the reader's words, and marked as not the AI's.
const unavailable = { summary: translate(getMessages('en-US'), 'savings.theAiCouldNotAnswerHereAre'), suggestions: fallback, wastedMonthlyCents: 0, source: 'unavailable' };
const validSuggestion = { title: 'Example title', detail: 'Example detail.' };

function reply(summary: unknown, suggestions: unknown) {
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ summary, suggestions }), model: 'mock-model' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent' } });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.createServer.mockResolvedValue({
    from: () => {
      const query: Record<string, unknown> = {};
      Object.assign(query, {
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
    expect(await response.json()).toEqual({ summary: 'Example summary.', suggestions: fallback, wastedMonthlyCents: 0, source: 'ai' });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('keeps valid suggestions in order and applies the four-item limit after removing unusable entries', async () => {
    const valid = Array.from({ length: 5 }, (_, index) => ({ title: ` Title ${index} `, detail: ` Detail ${index} ` }));
    reply('Example summary.', [null, {}, 'bad', { title: ' ', detail: 'Detail' }, ...valid]);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'Example summary.', suggestions: valid.slice(0, 4), wastedMonthlyCents: 0, source: 'ai' });
  });

  it.each(['', ' \n\t '])('uses the existing default for a blank summary (%j)', async (summary) => {
    reply(summary, [validSuggestion]);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: defaultSummary, suggestions: [validSuggestion], wastedMonthlyCents: 0, source: 'ai' });
  });

  it('preserves valid fenced JSON and the response envelope', async () => {
    const parsed = { summary: 'Example summary.', suggestions: [validSuggestion] };
    mocks.complete.mockResolvedValue({ text: '```json\n' + JSON.stringify(parsed) + '\n```', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...parsed, wastedMonthlyCents: 0, source: 'ai' });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ tools: [], maxTokens: 600 }));
  });

  it('answers an empty completion with the data-driven list, marked as not the AI’s', async () => {
    mocks.complete.mockResolvedValue({ text: '', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
  });

  it('answers malformed JSON with the data-driven list, marked as not the AI’s', async () => {
    mocks.complete.mockResolvedValue({ text: '{bad}', model: 'mock-model' });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
  });

  it('answers a rejected provider call with the data-driven list, marked as not the AI’s', async () => {
    mocks.complete.mockRejectedValue(new Error('Mock provider failure'));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unavailable);
  });
});
