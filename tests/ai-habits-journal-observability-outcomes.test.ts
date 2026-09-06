import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as habitsPOST } from '@/app/api/ai/habits/route';
import { POST as journalPOST } from '@/app/api/ai/journal/route';
import { parseCoachResponse } from '@/lib/habits/ai';
import { parseJournalPrompt, promptOfTheDay } from '@/lib/journal/prompts';
import type { AiObserver, AiRequestSpec } from '@/lib/ai/observability';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), provider: vi.fn(), complete: vi.fn(), rate: vi.fn(),
  used: vi.fn(), failed: vi.fn(), settled: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.provider }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.rate }));
vi.mock('@/lib/services/scope', () => ({
  scopeFromUserContext: (ctx: { active: { familyId: string }; user: { id: string } }, db: unknown) => ({
    db, familyId: ctx.active.familyId, userId: ctx.user.id,
  }),
}));
vi.mock('@/lib/ai/observability', () => ({
  async withAiRequest<T>(_scope: unknown, spec: AiRequestSpec, body: (obs: AiObserver) => Promise<T>): Promise<T> {
    const failures: unknown[] = [];
    try {
      const result = await body({
        requestId: 'request-a',
        used: mocks.used,
        failed: (error) => { failures.push(error); mocks.failed(error); },
      });
      // Snapshot the outcome immediately when the observed callback settles.
      // Parsing or reporting a failure later in the route cannot change it.
      mocks.settled({
        feature: spec.feature, status: failures.length ? 'failed' : 'completed',
        error: failures[0], rejected: false,
      });
      return result;
    } catch (error) {
      mocks.settled({ feature: spec.feature, status: 'failed', error, rejected: true });
      throw error;
    }
  },
}));
vi.mock('@/lib/habits/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/habits/ai')>();
  return { ...actual, parseCoachResponse: vi.fn(actual.parseCoachResponse) };
});
vi.mock('@/lib/journal/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/journal/prompts')>();
  return { ...actual, parseJournalPrompt: vi.fn(actual.parseJournalPrompt) };
});

const usage = { inputTokens: 12, outputTokens: 4 };
const reply = (text: string) => mocks.complete.mockResolvedValue({ text, model: 'test-model', usage });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.context.mockResolvedValue({
    user: { id: 'user-a' },
    active: {
      familyId: 'family-a', role: 'parent',
      family: { name: 'Family A', timezone: 'America/New_York' },
      member: { id: 'member-a', display_name: 'Sam' },
    },
  });
  const results: Record<string, { data: unknown[]; error: null }> = {
    habits: { data: [{ id: 'habit-a', title: 'Walk', cadence: 'daily', target_per_period: 1, weekdays: null }], error: null },
    habit_logs: { data: [], error: null },
    journal_entries: { data: [], error: null },
  };
  mocks.server.mockResolvedValue({
    from: (table: string) => {
      if (!results[table]) throw new Error(`Unexpected mocked table: ${table}`);
      return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(results[table]),
      };
    },
  });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.provider.mockResolvedValue({ complete: mocks.complete });
  reply('');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectOutcome(feature: string, status: 'completed' | 'failed', rejected = false) {
  expect(mocks.settled).toHaveBeenCalledOnce();
  expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ feature, status, rejected }));
  if (status === 'failed' && !rejected) {
    expect(mocks.failed).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.failed.mock.invocationCallOrder[0]).toBeLessThan(mocks.settled.mock.invocationCallOrder[0]);
  } else {
    expect(mocks.failed).not.toHaveBeenCalled();
  }
}

function expectUsage() {
  expect(mocks.used).toHaveBeenCalledOnce();
  expect(mocks.used).toHaveBeenCalledWith('test-model', usage);
  expect(mocks.used.mock.invocationCallOrder[0]).toBeLessThan(mocks.settled.mock.invocationCallOrder[0]);
}

describe('habit coach observed outcomes', () => {
  it.each([
    '', '  \n  ', 'not JSON', '{}',
    JSON.stringify({ headline: '  ', nudges: [' ', null, 42], suggestion: '' }),
  ])('records unusable output as failed before returning the existing 502 (%j)', async (text) => {
    reply(text);
    const response = await habitsPOST();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not generate coaching right now. Please try again.' });
    expectOutcome('habits.coach', 'failed');
    expectUsage();
    expect(vi.mocked(parseCoachResponse).mock.invocationCallOrder[0]).toBeLessThan(mocks.settled.mock.invocationCallOrder[0]);
  });

  it.each([
    { headline: 'Keep going.', nudges: [], suggestion: '' },
    { headline: '', nudges: ['Take one small step.'], suggestion: '' },
  ])('keeps useful coaching successful with intentionally empty fields (%j)', async (coaching) => {
    reply(JSON.stringify(coaching));
    const response = await habitsPOST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ coaching });
    expectOutcome('habits.coach', 'completed');
    expectUsage();
  });

  it('exposes a parsing exception to the observer and preserves the existing 500', async () => {
    const error = new Error('Synthetic coaching parse failure');
    vi.mocked(parseCoachResponse).mockImplementationOnce(() => { throw error; });
    reply('{}');
    const response = await habitsPOST();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to generate coaching' });
    expectOutcome('habits.coach', 'failed', true);
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ error }));
    expectUsage();
  });

  it('preserves provider failure reporting and the existing 500', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    const response = await habitsPOST();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to generate coaching' });
    expectOutcome('habits.coach', 'failed', true);
    expect(mocks.used).not.toHaveBeenCalled();
    expect(parseCoachResponse).not.toHaveBeenCalled();
  });
});

describe('journal prompt observed outcomes', () => {
  it.each(['', '  \n  ', '""', '1. '])('records unusable output as failed before the evergreen fallback (%j)', async (text) => {
    reply(text);
    const response = await journalPOST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prompt: promptOfTheDay(), source: 'evergreen' });
    expectOutcome('journal.prompt', 'failed');
    expectUsage();
    expect(vi.mocked(parseJournalPrompt).mock.invocationCallOrder[0]).toBeLessThan(mocks.settled.mock.invocationCallOrder[0]);
  });

  it.each([
    'What felt good today?',
    '  "What felt good today?"  \nAnother line',
  ])('keeps useful prompts successful with no recent journal entries (%j)', async (text) => {
    reply(text);
    const response = await journalPOST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prompt: 'What felt good today?', source: 'ai' });
    expectOutcome('journal.prompt', 'completed');
    expectUsage();
  });

  it('exposes a parsing exception to the observer before the same evergreen fallback', async () => {
    const error = new Error('Synthetic journal parse failure');
    vi.mocked(parseJournalPrompt).mockImplementationOnce(() => { throw error; });
    reply('What felt good today?');
    const response = await journalPOST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prompt: promptOfTheDay(), source: 'evergreen' });
    expectOutcome('journal.prompt', 'failed', true);
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ error }));
    expectUsage();
  });

  it('preserves provider failure reporting and the same evergreen fallback', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    const response = await journalPOST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prompt: promptOfTheDay(), source: 'evergreen' });
    expectOutcome('journal.prompt', 'failed', true);
    expect(mocks.used).not.toHaveBeenCalled();
    expect(parseJournalPrompt).not.toHaveBeenCalled();
  });
});
