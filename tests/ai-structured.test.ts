import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { conformNulls, UnsupportedSchemaError, zodToStrictJsonSchema } from '@/lib/ai/schema-to-json';
import { structured } from '@/lib/ai/structured';
import type { AIProvider, AIStructuredCompletion, AIStructuredInput } from '@/lib/ai/provider';

afterEach(() => vi.restoreAllMocks());

/** A provider that returns canned structured replies and records what it was asked. */
function fakeProvider(replies: (AIStructuredCompletion | Error)[]) {
  const calls: AIStructuredInput[] = [];
  const provider = {
    id: 'fake',
    model: 'gpt-4.1',
    complete: async () => { throw new Error('unused'); },
    runTools: async () => { throw new Error('unused'); },
    runToolsStream: async function* () { throw new Error('unused'); },
    structuredCompletion: async (input: AIStructuredInput) => {
      calls.push(input);
      const next = replies.shift();
      if (!next) throw new Error('fake provider ran out of replies');
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

function reply(content: unknown, usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }): AIStructuredCompletion {
  return { text: typeof content === 'string' ? content : JSON.stringify(content), refusal: null, usage };
}

// ── the emitted JSON Schema ──────────────────────────────────────────────────
// OpenAI's strict mode only accepts schemas where every object closes itself off
// and lists every key as required; anything looser silently degrades to
// best-effort generation, which is exactly what §5 forbids.
describe('zodToStrictJsonSchema emits strict schemas at every level', () => {
  const PlanSchema = z.object({
    objective: z.string().describe('what the family asked for'),
    risk: z.enum(['low', 'medium', 'high']),
    steps: z.array(z.object({
      tool: z.string(),
      sequence: z.number().int(),
      approvalRequired: z.boolean(),
      note: z.string().optional(),
      dependsOn: z.array(z.string()).nullable(),
    })),
  });

  function everyObject(node: unknown, seen: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (!node || typeof node !== 'object') return seen;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object' || (Array.isArray(obj.type) && obj.type.includes('object'))) seen.push(obj);
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach((v) => everyObject(v, seen));
      else if (value && typeof value === 'object') everyObject(value, seen);
    }
    return seen;
  }

  it('sets additionalProperties:false and a full required list on every object', () => {
    const schema = zodToStrictJsonSchema(PlanSchema);
    const objects = everyObject(schema);
    expect(objects.length).toBe(2);   // root + the step object
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as Record<string, unknown>));
    }
  });

  it('expresses optional and nullable fields as nullable types, never as absent keys', () => {
    const schema = zodToStrictJsonSchema(PlanSchema) as Record<string, never>;
    const step = ((schema.properties as Record<string, Record<string, unknown>>).steps.items) as Record<string, Record<string, Record<string, unknown>>>;
    expect(step.properties.note.type).toEqual(['string', 'null']);
    expect(step.properties.dependsOn.type).toEqual(['array', 'null']);
    expect(step.properties.sequence.type).toBe('integer');
  });

  it('carries .describe() text through and collapses a literal union to one enum', () => {
    const schema = zodToStrictJsonSchema(z.object({
      objective: z.string().describe('what the family asked for'),
      kind: z.union([z.literal('meal'), z.literal('chore')]),
      status: z.enum(['ok', 'blocked']).nullable(),
    })) as Record<string, Record<string, Record<string, unknown>>>;
    expect(schema.properties.objective.description).toBe('what the family asked for');
    expect(schema.properties.kind).toEqual({ type: 'string', enum: ['meal', 'chore'] });
    // A nullable enum must offer null in both the type and the enum list.
    expect(schema.properties.status).toEqual({ type: ['string', 'null'], enum: ['ok', 'blocked', null] });
  });

  it('refuses schemas it cannot represent faithfully rather than emitting a wrong one', () => {
    expect(() => zodToStrictJsonSchema(z.object({ blob: z.record(z.string()) }))).toThrow(UnsupportedSchemaError);
    expect(() => zodToStrictJsonSchema(z.object({ when: z.date() }))).toThrow(/Unsupported zod type ZodDate at when/);
    expect(() => zodToStrictJsonSchema(z.array(z.string()) as never)).toThrow(UnsupportedSchemaError);
  });
});

// Strict mode has no "absent key", so an `.optional()` field comes back as null —
// which zod rejects. conformNulls is what keeps a schema-faithful reply valid.
describe('conformNulls bridges strict-mode nulls to zod optionality', () => {
  it('drops nulls for optional fields but keeps them for nullable ones', () => {
    const schema = z.object({
      note: z.string().optional(),
      owner: z.string().nullable(),
      tags: z.array(z.object({ label: z.string(), colour: z.string().optional() })),
    });
    const conformed = conformNulls(schema, { note: null, owner: null, tags: [{ label: 'a', colour: null }] });
    expect(schema.safeParse(conformed).success).toBe(true);
    expect(conformed).toEqual({ owner: null, tags: [{ label: 'a' }] });
  });

  it('keeps null where the optional wraps a nullable', () => {
    const schema = z.object({ note: z.string().nullable().optional() });
    expect(conformNulls(schema, { note: null })).toEqual({ note: null });
  });

  it('picks the union branch that actually validates', () => {
    const schema = z.union([
      z.object({ kind: z.literal('tool'), name: z.string(), args: z.string().optional() }),
      z.object({ kind: z.literal('note'), body: z.string() }),
    ]);
    const conformed = conformNulls(schema, { kind: 'tool', name: 'calendar.createEvent', args: null });
    expect(schema.safeParse(conformed).success).toBe(true);
  });
});

// ── the structured() call itself ─────────────────────────────────────────────
describe('structured()', () => {
  const Schema = z.object({ intent: z.enum(['plan_meals', 'plan_week']), confidence: z.number(), note: z.string().optional() });

  it('parses a valid structured reply and sends a strict json_schema request', async () => {
    const { provider, calls } = fakeProvider([reply({ intent: 'plan_meals', confidence: 0.9, note: null })]);
    const result = await structured({
      schema: Schema, schemaName: 'family_intent', system: 'you plan', messages: [{ role: 'user', content: 'dinner for the week' }],
      task: 'classify', provider,
    });

    expect(result).toEqual({ ok: true, data: { intent: 'plan_meals', confidence: 0.9 }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].schemaName).toBe('family_intent');
    expect(calls[0].jsonSchema.additionalProperties).toBe(false);
  });

  it('repairs exactly once, feeding the validation errors back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, calls } = fakeProvider([
      reply({ intent: 'plan_meals', confidence: 'high' }),
      reply({ intent: 'plan_meals', confidence: 0.4, note: null }),
    ]);

    const result = await structured({ schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }], provider });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const repairMessages = calls[1].messages;
    // The model sees its own reply plus the exact zod complaint about it.
    expect(repairMessages.at(-2)?.content).toContain('"confidence":"high"');
    expect(repairMessages.at(-1)?.content).toMatch(/confidence: Expected number/);
    // Usage is summed across both attempts.
    expect(result.ok && result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it('fails cleanly after one repair instead of looping', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, calls } = fakeProvider([
      reply({ intent: 'nope', confidence: 1 }),
      reply({ intent: 'still-nope', confidence: 1 }),
      reply({ intent: 'plan_week', confidence: 1 }),   // never requested
    ]);

    const result = await structured({ schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }], provider });

    expect(result).toEqual({ ok: false, code: 'invalid_output', error: 'The AI could not produce a reply in the required format.' });
    expect(calls).toHaveLength(2);   // one repair, not two
  });

  it('repairs unparseable JSON once, then reports invalid_json', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, calls } = fakeProvider([reply('Sure! {intent: plan_meals'), reply('still not json')]);
    const result = await structured({ schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }], provider });
    expect(result).toEqual({ ok: false, code: 'invalid_json', error: 'The AI returned a reply that was not valid JSON.' });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1)?.content).toMatch(/not valid JSON/);
  });

  it('surfaces a refusal without spending a repair round', async () => {
    const { provider, calls } = fakeProvider([{ text: '', refusal: 'I cannot help with that.', usage: null }]);
    const result = await structured({ schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }], provider });
    expect(result).toEqual({ ok: false, code: 'refusal', error: 'I cannot help with that.' });
    expect(calls).toHaveLength(1);
  });

  it('classifies a provider failure instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider } = fakeProvider([new Error('OpenAI error 401: Incorrect API key provided')]);
    const result = await structured({ schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }], provider });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('auth');
  });

  it('reports an unconvertible schema before making any call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { provider, calls } = fakeProvider([]);
    const result = await structured({
      schema: z.object({ when: z.date() }), schemaName: 'bad', system: 's', messages: [{ role: 'user', content: 'x' }], provider,
    });
    expect(result.ok === false && result.code).toBe('schema');
    expect(calls).toHaveLength(0);
  });

  it('stops on an already-aborted signal without calling the provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = fakeProvider([reply({ intent: 'plan_meals', confidence: 1 })]);
    const result = await structured({
      schema: Schema, schemaName: 'family_intent', system: 's', messages: [{ role: 'user', content: 'x' }],
      provider, signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, code: 'cancelled', error: 'That request was cancelled.' });
    expect(calls).toHaveLength(0);
  });
});
