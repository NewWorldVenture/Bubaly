import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  isAIConfigured: vi.fn(),
  resolveProvider: vi.fn(),
  describeAIError: vi.fn(),
  complete: vi.fn(),
  used: vi.fn(),
  failed: vi.fn(),
  callbackFailed: vi.fn(),
  settled: [] as Array<{ text: unknown; failed: boolean }>,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: mocks.isAIConfigured,
  resolveProvider: mocks.resolveProvider,
  describeAIError: mocks.describeAIError,
}));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/ai/insights', () => ({
  INSIGHTS: { chores: { system: 'Fixture system', buildUser: () => 'Fixture rows', maxTokens: 100 } },
  isInsightKind: (kind: unknown) => kind === 'chores',
  MANAGER_ONLY_INSIGHTS: new Set(),
}));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used; failed: typeof mocks.failed }) => Promise<unknown>,
  ) => {
    try {
      const text = await run({ used: mocks.used, failed: mocks.failed });
      mocks.settled.push({ text, failed: mocks.failed.mock.calls.length > 0 });
      return text;
    } catch (error) {
      mocks.callbackFailed(error);
      throw error;
    }
  },
}));

import { POST } from '@/app/api/ai/insights/route';

function request() {
  return new Request('http://localhost/api/ai/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'chores' }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settled.length = 0;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent', family: { name: 'Test household', timezone: 'UTC' } },
  });
  mocks.isAIConfigured.mockResolvedValue(true);
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.describeAIError.mockReturnValue({ message: 'AI is temporarily unavailable.' });
  mocks.complete.mockResolvedValue({ text: 'A useful suggestion.', model: 'mock-model' });
  mocks.createServer.mockResolvedValue({
    from: (table: string) => {
      if (!['family_members', 'chores', 'chore_assignments'].includes(table)) {
        throw new Error(`Unexpected mocked table: ${table}`);
      }
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        limit: () => query,
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
      };
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

describe('insight response integrity', () => {
  it.each(['', '   ', '\n\t'])('marks blank output %j failed before the observed request settles', async (text) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'No suggestions just now. Please try again.' });
    expect(mocks.used).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(mocks.settled).toEqual([{ text: '', failed: true }]);
  });

  it('preserves the trimmed successful response without marking it failed', async () => {
    mocks.complete.mockResolvedValue({ text: '  A useful suggestion.\n', model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'A useful suggestion.' });
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.settled).toEqual([{ text: 'A useful suggestion.', failed: false }]);
  });

  it('keeps provider rejection inside the observed callback and returns the existing 503', async () => {
    const failure = new Error('Mocked provider failure');
    mocks.complete.mockRejectedValue(failure);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI is temporarily unavailable.' });
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.settled).toEqual([]);
  });

  it('keeps malformed text conversion inside the observed callback', async () => {
    mocks.complete.mockResolvedValue({ text: null, model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI is temporarily unavailable.' });
    expect(mocks.callbackFailed).toHaveBeenCalledExactlyOnceWith(expect.any(TypeError));
    expect(mocks.settled).toEqual([]);
  });
});
