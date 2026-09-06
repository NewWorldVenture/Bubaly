import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
  used: vi.fn(),
  failed: vi.fn(),
  trace: [] as string[],
  settledValue: undefined as unknown,
  week: {
    aheadStart: '2026-09-07T00:00:00.000Z',
    aheadEnd: '2026-09-13T23:59:59.999Z',
    recapStart: '2026-08-31T00:00:00.000Z',
    recapEnd: '2026-09-06T23:59:59.999Z',
    days: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'],
  },
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: mocks.requireUserContext,
  effectivePlanLevel: () => 2,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 2 }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/ai/weekly', () => ({
  weekWindow: () => mocks.week,
  weekRangeLabel: () => 'Sep 7 - Sep 13',
  choreCompletionRate: () => 0,
  bucketByDay: () => ({}),
  dayLoad: () => 'light',
}));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used; failed: (error: Error) => void }) => Promise<unknown>,
  ) => {
    let failed = false;
    try {
      const value = await run({
        used: mocks.used,
        failed: (error) => {
          failed = true;
          mocks.failed(error);
          mocks.trace.push('failed');
        },
      });
      mocks.settledValue = value;
      mocks.trace.push(failed ? 'settled:failed' : 'settled:completed');
      return value;
    } catch (error) {
      mocks.trace.push('settled:failed');
      throw error;
    }
  },
}));

import { POST } from '@/app/api/ai/weekly-briefing/route';

const fallback = {
  weekRange: 'Sep 7 - Sep 13',
  headline: 'Here\u2019s your week, Alex.',
  summary: ['Your weekly briefing is being processed \u2014 refresh in a moment.'],
  recap: { choreCompletion: 0, wins: [], misses: [], note: 'Keep it up!' },
  dayByDay: [
    ['Monday', 'Sep 7'], ['Tuesday', 'Sep 8'], ['Wednesday', 'Sep 9'],
    ['Thursday', 'Sep 10'], ['Friday', 'Sep 11'], ['Saturday', 'Sep 12'], ['Sunday', 'Sep 13'],
  ].map(([day, date]) => ({ day, date, emoji: '\ud83d\udcc5', load: 'light', events: [] })),
  highlights: [],
  conflicts: [],
  prepChecklist: [],
  weeklyScore: { overall: 75, categories: [], stressLevel: 'low', stressReason: null, focus: 'Have a great week!' },
  focusOfTheWeek: 'Have a great week!',
};

function request() {
  return new NextRequest('http://localhost/api/ai/weekly-briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.trace = [];
  mocks.settledValue = undefined;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', family: { name: 'Example family' }, member: { display_name: 'Alex Example' } },
  });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.used.mockImplementation(() => { mocks.trace.push('used'); });
  mocks.createServer.mockResolvedValue({
    from: () => {
      const query: Record<string, unknown> = {};
      Object.assign(query, {
        select: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        order: () => query,
        limit: () => query,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      });
      return query;
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('weekly briefing observed outcomes', () => {
  it.each([
    { label: 'malformed JSON', text: '{bad}' },
    { label: 'malformed fenced JSON', text: '```json\n{"headline":}\n```' },
    { label: 'multiple JSON objects', text: '{"headline":"first"} {"headline":"second"}' },
    { label: 'nonstring completion text', text: {} },
  ])('reports $label before settlement and preserves the successful fallback response', async ({ text }) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ briefing: fallback, generatedAt: expect.any(String), weekKey: '2026-09-07' });
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(mocks.trace).toEqual(['used', 'failed', 'settled:failed']);
    expect(mocks.settledValue).toBeNull();
  });

  it.each([
    { label: 'empty JSON object', text: '{}' },
    { label: 'empty text', text: '' },
    { label: 'missing text', text: undefined },
    { label: 'text without a JSON object', text: 'No JSON object' },
  ])('preserves the existing successful empty/default result for $label', async ({ text }) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ briefing: {}, generatedAt: expect.any(String), weekKey: '2026-09-07' });
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.trace).toEqual(['used', 'settled:completed']);
  });

  it.each(['plain', 'fenced'])('keeps valid %s responses and empty collections successful', async (format) => {
    const briefing = { ...fallback, headline: 'Example week.', summary: [], focusOfTheWeek: 'Example focus.' };
    const text = JSON.stringify(briefing);
    const usage = { inputTokens: 20, outputTokens: 30 };
    mocks.complete.mockResolvedValue({ text: format === 'fenced' ? '```json\n' + text + '\n```' : text, model: 'mock-model', usage });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ briefing, generatedAt: expect.any(String), weekKey: '2026-09-07' });
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.trace).toEqual(['used', 'settled:completed']);
    expect(mocks.used).toHaveBeenCalledExactlyOnceWith('mock-model', usage);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ tools: [], maxTokens: 2600 }));
  });

  it('preserves the existing HTTP error for a rejected provider call', async () => {
    mocks.complete.mockRejectedValue(new Error('Mock provider failure'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to generate weekly briefing' });
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.trace).toEqual(['settled:failed']);
  });
});
