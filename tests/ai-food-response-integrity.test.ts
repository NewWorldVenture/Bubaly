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
  upsert: vi.fn(),
  cached: null as Record<string, unknown> | null,
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
vi.mock('@/lib/meals/planner', () => ({ weekDates: vi.fn() }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (
    _scope: unknown,
    _meta: unknown,
    run: (obs: { used: typeof mocks.used; failed: typeof mocks.failed }) => Promise<unknown>,
  ) => run(mocks),
}));

import { POST } from '@/app/api/ai/meals/nutrition/route';

function request() {
  return new Request('http://localhost/api/ai/meals/nutrition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectType: 'recipe', subjectId: 'recipe-1' }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cached = null;
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1' } });
  mocks.isAIConfigured.mockResolvedValue(true);
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.describeAIError.mockReturnValue({ message: 'AI is temporarily unavailable.' });
  mocks.complete.mockResolvedValue({ text: '{"calories":500}', model: 'mock-model' });
  mocks.upsert.mockImplementation((row: Record<string, unknown>) => ({
    select: () => ({ single: async () => ({ data: { id: 'nutrition-1', ...row }, error: null }) }),
  }));
  mocks.createServer.mockResolvedValue({
    from: (table: string) => {
      if (table !== 'family_recipes' && table !== 'meal_nutrition') {
        throw new Error(`Unexpected mocked table: ${table}`);
      }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === 'family_recipes'
            ? { name: 'Example dish', servings: 2, ingredients: [], category: 'dinner', allergy_flags: [] }
            : mocks.cached,
          error: null,
        }),
        upsert: mocks.upsert,
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

describe('nutrition endpoint response integrity', () => {
  it.each([
    ['empty JSON object', '{}'],
    ['empty completion', ''],
    ['prose without JSON', 'No estimate available'],
    ['broken JSON', '{"calories":'],
  ])('rejects %s without caching a successful estimate', async (_label, text) => {
    mocks.complete.mockResolvedValue({ text, model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Could not read the nutrition estimate. Try again.' });
    expect(mocks.failed).toHaveBeenCalledOnce();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('returns the existing unavailable response when numeric coercion throws', async () => {
    mocks.complete.mockResolvedValue({ text: '{"calories":{"toString":null}}', model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI is temporarily unavailable.' });
    expect(mocks.describeAIError).toHaveBeenCalledWith(expect.any(TypeError));
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each(['plain', 'fenced'])('preserves coercion and the successful envelope for %s JSON', async (format) => {
    const summary = 'Example summary. '.repeat(30);
    const text = JSON.stringify({ calories: '650.4', protein_g: 30.25, sodium_mg: -5, summary });
    mocks.complete.mockResolvedValue({ text: format === 'fenced' ? `\`\`\`json\n${text}\n\`\`\`` : text, model: 'mock-model' });
    const row = {
      family_id: 'family-1', subject_type: 'recipe', subject_id: 'recipe-1', servings: 2,
      calories: 650, protein_g: 30.3, carbs_g: 0, fat_g: 0,
      fiber_g: 0, sugar_g: 0, sodium_mg: 0,
      summary: summary.slice(0, 280), details: null, created_by: 'user-1',
    };

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nutrition: { id: 'nutrition-1', ...row }, cached: false });
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(row, { onConflict: 'family_id,subject_type,subject_id' });
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it('retains explicitly supplied zero values', async () => {
    const zeroes = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };
    mocks.complete.mockResolvedValue({ text: JSON.stringify(zeroes), model: 'mock-model' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nutrition: { ...zeroes, summary: null }, cached: false });
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it('returns an existing cache hit without asking the provider or writing', async () => {
    mocks.cached = { id: 'cached-nutrition', calories: 500 };

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ nutrition: mocks.cached, cached: true });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
