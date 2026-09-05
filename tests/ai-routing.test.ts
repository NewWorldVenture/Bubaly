import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkModelForTask, resolveModelForTask, taskEnvVar } from '@/lib/ai/routing';
import { AI_TASKS, DEFAULT_TASK_MODELS, modelCapabilities } from '@/lib/ai/models';
import { OpenAIProvider } from '@/lib/ai/provider';

afterEach(() => vi.restoreAllMocks());

describe('task → model defaults', () => {
  it('routes the cheap tasks to the cheap model and only planning to the strong one', () => {
    expect(DEFAULT_TASK_MODELS.classify).toBe('gpt-4o-mini');
    expect(DEFAULT_TASK_MODELS.extract).toBe('gpt-4o-mini');
    expect(DEFAULT_TASK_MODELS.summarize).toBe('gpt-4o-mini');
    expect(DEFAULT_TASK_MODELS.transform).toBe('gpt-4o-mini');
    expect(DEFAULT_TASK_MODELS.plan).toBe('gpt-4.1');
    expect(DEFAULT_TASK_MODELS.reason).toBe('gpt-4.1');
    expect(DEFAULT_TASK_MODELS.vision).toBe('gpt-4o');
  });

  it('has a default that satisfies its own task requirements', () => {
    for (const task of AI_TASKS) {
      expect(checkModelForTask(DEFAULT_TASK_MODELS[task], task).ok, `${task} default`).toBe(true);
    }
  });
});

describe('resolveModelForTask precedence', () => {
  it('prefers the env override over stored settings and defaults', () => {
    const resolution = resolveModelForTask('plan', { env: { AI_MODEL_PLAN: 'gpt-4o' }, configured: 'o4-mini' });
    expect(resolution).toMatchObject({ model: 'gpt-4o', source: 'env' });
    expect(taskEnvVar('plan')).toBe('AI_MODEL_PLAN');
  });

  it('falls back to the stored per-task model, then to the default', () => {
    expect(resolveModelForTask('classify', { env: {}, configured: 'gpt-4o' })).toMatchObject({ model: 'gpt-4o', source: 'settings' });
    expect(resolveModelForTask('classify', { env: {}, configured: null })).toMatchObject({ model: 'gpt-4o-mini', source: 'default' });
  });
});

describe('capability allow-list', () => {
  it('rejects a model that cannot do strict structured output and degrades to the default', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // gpt-3.5-turbo only supports json_object, so a plan built with it would be
    // scraped out of prose — exactly the failure §5 forbids.
    const resolution = resolveModelForTask('plan', { env: {}, configured: 'gpt-3.5-turbo' });
    expect(resolution.model).toBe(DEFAULT_TASK_MODELS.plan);
    expect(resolution.source).toBe('default');
    expect(resolution.rejected).toEqual([{ model: 'gpt-3.5-turbo', source: 'settings', reason: 'missing jsonSchema support' }]);
    expect(String(err.mock.calls[0][0])).toContain('rejected for task "plan"');
  });

  it('rejects a model that is not on the allow-list at all', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolution = resolveModelForTask('classify', { env: { AI_MODEL_CLASSIFY: 'llama-3-70b' } });
    expect(resolution.model).toBe('gpt-4o-mini');
    expect(resolution.rejected[0].reason).toMatch(/allow-list/);
  });

  it('rejects a text-only model for a vision task', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(checkModelForTask('o3-mini', 'vision')).toEqual({ ok: false, reason: 'missing vision support' });
    expect(resolveModelForTask('vision', { env: {}, configured: 'o3-mini' }).model).toBe('gpt-4o');
  });

  it('matches capability prefixes longest-first so gpt-4o-mini is not read as gpt-4o', () => {
    expect(modelCapabilities('gpt-4o-mini-2024-07-18')?.maxTokensParam).toBe('max_tokens');
    expect(modelCapabilities('o4-mini-2025-04-16')?.maxTokensParam).toBe('max_completion_tokens');
    expect(modelCapabilities('llama-3')).toBeNull();
  });
});

// The o-series Chat Completions endpoint rejects `max_tokens` outright, so the
// parameter name has to follow the model family or every call 400s.
describe('request body shape per model family', () => {
  function jsonResponse(payload: unknown) {
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(payload)),
      headers: { get: () => null },
    } as unknown as Response);
  }

  async function bodyFor(model: string) {
    const fetchMock = vi.fn().mockReturnValue(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAIProvider(model, 'test-key').complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 256 });
    return JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
  }

  it('sends max_tokens for gpt models and max_completion_tokens for o-series', async () => {
    expect(await bodyFor('gpt-4o')).toMatchObject({ model: 'gpt-4o', max_tokens: 256 });
    expect((await bodyFor('gpt-4o')).max_completion_tokens).toBeUndefined();
    expect(await bodyFor('o4-mini')).toMatchObject({ model: 'o4-mini', max_completion_tokens: 256 });
    expect((await bodyFor('o4-mini')).max_tokens).toBeUndefined();
  });

  it('sends a strict json_schema response_format on the structured path', async () => {
    const fetchMock = vi.fn().mockReturnValue(jsonResponse({ choices: [{ message: { content: '{"a":1}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAIProvider('gpt-4.1', 'test-key').structuredCompletion({
      system: 's', messages: [{ role: 'user', content: 'hi' }],
      schemaName: 'family_plan', jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'family_plan', strict: true, schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    });
  });

  it('refuses to silently degrade when the model cannot do json_schema', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new OpenAIProvider('gpt-3.5-turbo', 'test-key').structuredCompletion({
      system: 's', messages: [], schemaName: 'x', jsonSchema: { type: 'object' },
    })).rejects.toThrow(/does not support strict json_schema/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
