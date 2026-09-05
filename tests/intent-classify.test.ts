// The composed intent classifier: deterministic recognisers first — the
// concierge workflow vocabulary, lib/intent/detect.ts goals, the voice/capture
// rules, contact-center inbound intents, navigation, plain questions — and the
// cheap model only for what none of them recognise. The provider is a spy, so
// "fast paths win before any model call" is proven, not assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@/lib/ai/provider';
import { classifyIntent, classifyIntentFast, INTENT_KEYS, INTENT_SLICES, type IntentKey } from '@/lib/ai/context/intents';

const NOW = new Date('2026-09-05T15:00:00Z');

function scriptedProvider(reply: unknown): { provider: AIProvider; calls: { schemaName: string; jsonSchema: Record<string, unknown>; system: string }[] } {
  const calls: { schemaName: string; jsonSchema: Record<string, unknown>; system: string }[] = [];
  const provider = {
    model: 'scripted',
    async complete() { throw new Error('not used'); },
    async runTools() { throw new Error('not used'); },
    async *runToolsStream() { throw new Error('not used'); },
    async structuredCompletion(input: { schemaName: string; jsonSchema: Record<string, unknown>; system: string }) {
      calls.push({ schemaName: input.schemaName, jsonSchema: input.jsonSchema, system: input.system });
      return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), refusal: null, usage: null };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('fast paths', () => {
  const cases: [string, IntentKey][] = [
    ['Plan our meals for next week', 'plan_meals'],
    ["What's for dinner tonight?", 'plan_meals'],
    ['Plan our week', 'plan_week'],
    ['Organize our weekend', 'organize_weekend'],
    ['What should we do this weekend', 'organize_weekend'],
    ['Remind everyone about the dentist tomorrow', 'remind_everyone'],
    ['Tell the kids that dinner is at 6', 'remind_everyone'],
    ['Prepare us for the trip to Denver', 'prepare_vacation'],
    ['Packing list for Florida', 'prepare_vacation'],
    ['Why did we spend too much last month?', 'spending_review'],
    ['Are we over budget on groceries', 'spending_review'],
    ['Find a plumber for the leaking sink', 'find_vendor'],
    ['We need an electrician', 'find_vendor'],
    ['What am I forgetting this week?', 'what_am_i_forgetting'],
    ['Are we ready for Monday?', 'what_am_i_forgetting'],
    ['Give me my daily brief', 'daily_brief'],
    ["What's on today?", 'daily_brief'],
    ['Open the calendar', 'navigate'],
    ['Show me the grocery list', 'navigate'],
    ['Remind me to call the vet', 'capture'],
    ['Add milk and eggs to the grocery list', 'capture'],
    ['Buy batteries', 'capture'],
    ['Dentist tomorrow at 3pm', 'capture'],
    ["Who's free Saturday afternoon?", 'answer_question'],
    ['Should we do soccer or swim this fall?', 'answer_question'],
    ['When is Maya’s next practice?', 'answer_question'],
  ];

  for (const [text, intent] of cases) {
    it(`"${text}" → ${intent} without a model`, () => {
      const result = classifyIntentFast(text, { now: NOW });
      expect(result?.intent).toBe(intent);
      expect(result?.source).toBe('fast_path');
      expect(result?.confidence).toBeGreaterThan(0.5);
    });
  }

  it('carries entities from the recognisers', () => {
    const capture = classifyIntentFast('Dentist tomorrow at 3pm', { now: NOW });
    expect(capture?.entities.kind).toBe('event');
    expect(capture?.entities.startsAt).toMatch(/^2026-09-06T/);
    const nav = classifyIntentFast('open the calendar', { now: NOW });
    expect(nav?.entities.target).toBe('calendar');
    const goal = classifyIntentFast("who's free Saturday?", { now: NOW });
    expect(goal?.entities.topic).toBe('availability');
  });

  it('reads inbound-message intents only on inbox-like pages', () => {
    const text = 'Hi, this is Dr. Lee’s office calling to confirm your appointment, please call us back';
    expect(classifyIntentFast(text, { now: NOW })).toBeNull();
    const inbox = classifyIntentFast(text, { now: NOW, pageContext: { module: 'inbox' } });
    expect(inbox?.intent).toBe('capture');
    expect(inbox?.entities.inbound).toBe('appointment');
  });

  it('returns null for text nothing recognises, so the model decides', () => {
    expect(classifyIntentFast('Maya seems tired lately and I am not sure what to change', { now: NOW })).toBeNull();
    expect(classifyIntentFast('thoughts on the new school schedule', { now: NOW })).toBeNull();
  });

  it('treats empty input as other, with certainty', () => {
    expect(classifyIntentFast('   ')).toEqual({ intent: 'other', confidence: 1, entities: {}, source: 'fast_path' });
  });
});

describe('classifyIntent', () => {
  const scope = { familyId: 'fam-1', requestId: null, now: NOW };

  it('never calls the model when a fast path matched', async () => {
    const { provider, calls } = scriptedProvider({ intent: 'other', confidence: 1, entities: [] });
    const result = await classifyIntent(scope, 'Plan our meals for next week', { provider });
    expect(result.intent).toBe('plan_meals');
    expect(result.source).toBe('fast_path');
    expect(calls).toHaveLength(0);
  });

  it('asks the cheap model with a strict enum schema for unrecognised text and maps its reply', async () => {
    const { provider, calls } = scriptedProvider({ intent: 'answer_question', confidence: 0.8, entities: [{ key: 'person', value: 'Maya' }] });
    const result = await classifyIntent(scope, 'Maya seems tired lately and I am not sure what to change', { provider });
    expect(calls).toHaveLength(1);
    expect(calls[0].schemaName).toBe('request_intent');
    const props = calls[0].jsonSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.intent.enum).toEqual([...INTENT_KEYS]);
    expect(calls[0].jsonSchema.additionalProperties).toBe(false);
    expect(result).toEqual({ intent: 'answer_question', confidence: 0.8, entities: { person: 'Maya' }, source: 'model' });
  });

  it('rejects an intent outside the enum and degrades to other rather than trusting the model', async () => {
    const { provider, calls } = scriptedProvider({ intent: 'delete_everything', confidence: 1, entities: [] });
    const result = await classifyIntent(scope, 'Maya seems tired lately and I am not sure what to change', { provider });
    // One original attempt plus the single repair round, then a clean failure.
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ intent: 'other', confidence: 0, entities: {}, source: 'model' });
  });

  it('degrades to other when the provider is down', async () => {
    const provider = {
      model: 'down',
      async structuredCompletion() { throw new Error('ECONNRESET'); },
    } as unknown as AIProvider;
    const result = await classifyIntent(scope, 'thoughts on the new school schedule', { provider });
    expect(result.intent).toBe('other');
    expect(result.source).toBe('model');
  });
});

describe('INTENT_SLICES', () => {
  it('follows §27: a meal plan never loads documents, vendors or travel', () => {
    for (const slice of ['documents', 'vendors', 'travel']) expect(INTENT_SLICES.plan_meals).not.toContain(slice);
    expect(INTENT_SLICES.plan_meals).toEqual(expect.arrayContaining(['food', 'schedule', 'shopping', 'money', 'memory']));
    expect(INTENT_SLICES.prepare_vacation).toContain('documents');
    expect(INTENT_SLICES.find_vendor).toContain('vendors');
    expect(INTENT_SLICES.spending_review).toContain('money');
    expect(INTENT_SLICES.navigate).toEqual(['people']);
  });
});
