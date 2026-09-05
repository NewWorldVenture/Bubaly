// The plan schema is what OpenAI's strict json_schema mode constrains the
// model with, so its emitted form has to satisfy strict mode's rules at every
// level — and a reply that honours the schema (nulls for the optional slots,
// JSON strings for step inputs) has to round-trip back through zod and the
// input parser without loss.
import { describe, expect, it } from 'vitest';
import { conformNulls, zodToStrictJsonSchema } from '@/lib/ai/schema-to-json';
import {
  decodeConditionValue, encodeStepInput, MAX_STEPS, parseStepInput, PLAN_SCHEMA_NAME, PlanSchema,
  PLAN_STEP_TYPES, toExecutorCondition, type Plan,
} from '@/lib/ai/planner/schema';
import { instantiateTemplate, allTemplates, templateContextFrom } from '@/lib/ai/planner/templates/index';

type JsonObject = Record<string, unknown>;

/** Every JSON-Schema node that describes an object, anywhere in the tree. */
function everyObject(node: unknown, seen: JsonObject[] = []): JsonObject[] {
  if (!node || typeof node !== 'object') return seen;
  const obj = node as JsonObject;
  const type = obj.type;
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) seen.push(obj);
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach((v) => everyObject(v, seen));
    else if (value && typeof value === 'object') everyObject(value, seen);
  }
  return seen;
}

/** Keywords strict mode rejects. If any appears, the request 400s in production. */
const FORBIDDEN_KEYWORDS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'minimum', 'maximum'];

function everyKeyword(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (FORBIDDEN_KEYWORDS.includes(key)) found.push(key);
    if (Array.isArray(value)) value.forEach((v) => everyKeyword(v, found));
    else if (value && typeof value === 'object') everyKeyword(value, found);
  }
  return found;
}

describe('PlanSchema is strict-mode compatible', () => {
  const schema = zodToStrictJsonSchema(PlanSchema);

  it('has a valid OpenAI schema name', () => {
    expect(PLAN_SCHEMA_NAME).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('closes every object and lists every key as required, at every level', () => {
    const objects = everyObject(schema);
    // root, step, condition, followup, clarification
    expect(objects.length).toBe(5);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as JsonObject));
    }
  });

  it('carries no length, pattern or bound keywords strict mode rejects', () => {
    expect(everyKeyword(schema)).toEqual([]);
  });

  it('expresses every optional slot as nullable and present', () => {
    const props = schema.properties as Record<string, JsonObject>;
    expect(props.clarification.type).toEqual(['object', 'null']);
    expect(props.answer.type).toEqual(['string', 'null']);
    const step = (props.steps.items as JsonObject).properties as Record<string, JsonObject>;
    expect(step.tool_name.type).toEqual(['string', 'null']);
    expect(step.condition.type).toEqual(['object', 'null']);
    expect(step.approval_required.type).toEqual(['boolean', 'null']);
    expect(step.verify.type).toEqual(['string', 'null']);
    expect(step.input.type).toBe('string');
    expect(step.step_type.enum).toEqual([...PLAN_STEP_TYPES]);
  });

  it('does not offer the model a replan step', () => {
    expect(PLAN_STEP_TYPES).not.toContain('replan');
  });
});

describe('a strict-mode reply round-trips', () => {
  const reply = {
    objective: 'Plan the week',
    reasoning_summary: 'Dinners around soccer.',
    risk_level: 'low',
    steps: [{
      key: 'a', step_type: 'act', tool_name: 'meals.planWeek', description: 'Plan dinners',
      input: '{"entries":[{"date":"2026-09-14","meal_name":"Tacos"}]}',
      depends_on: [], condition: null, approval_required: null, verify: null,
    }, {
      key: 'b', step_type: 'notify', tool_name: null, description: 'Tell the family',
      input: '{"recipients":"family","type":"system","title":"Done"}',
      depends_on: ['a'], condition: { path: 'deps[0].count', eq: '3', ne: null, exists: null }, approval_required: true, verify: null,
    }],
    followups: [],
    clarification: null,
    answer: null,
  };

  it('parses with nulls in every optional slot', () => {
    const parsed = PlanSchema.safeParse(conformNulls(PlanSchema, reply));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.steps[0].condition).toBeNull();
    expect(parsed.data.steps[1].approval_required).toBe(true);
  });

  it('rejects extra keys, so a hallucinated field never reaches the executor', () => {
    const parsed = PlanSchema.safeParse({ ...reply, steps: [{ ...reply.steps[0], tool_args: {} }] });
    expect(parsed.success).toBe(false);
  });

  it('decodes the step input string into the object the tool schema checks', () => {
    const decoded = parseStepInput(reply.steps[0].input);
    expect(decoded).toEqual({ ok: true, value: { entries: [{ date: '2026-09-14', meal_name: 'Tacos' }] } });
    expect(parseStepInput(encodeStepInput({ a: 1, b: [null] }))).toEqual({ ok: true, value: { a: 1, b: [null] } });
  });

  it('treats an empty input as no arguments and anything else malformed as an error', () => {
    expect(parseStepInput('')).toEqual({ ok: true, value: {} });
    expect(parseStepInput('  ')).toEqual({ ok: true, value: {} });
    expect(parseStepInput(null)).toEqual({ ok: true, value: {} });
    expect(parseStepInput('{not json')).toEqual({ ok: false, error: 'input is not valid JSON' });
    expect(parseStepInput('[1,2]')).toEqual({ ok: false, error: 'input must be a JSON object' });
    expect(parseStepInput('"text"')).toEqual({ ok: false, error: 'input must be a JSON object' });
  });

  it('decodes JSON-encoded condition values to their real types', () => {
    expect(decodeConditionValue('true')).toBe(true);
    expect(decodeConditionValue('3')).toBe(3);
    expect(decodeConditionValue('"dinner"')).toBe('dinner');
    expect(decodeConditionValue('dinner')).toBe('dinner');
    expect(decodeConditionValue(null)).toBeUndefined();
  });

  it('turns a condition into the executor shape with only the comparison that was set', () => {
    expect(toExecutorCondition({ path: 'deps[0].count', eq: '3', ne: null, exists: null })).toEqual({ path: 'deps[0].count', eq: 3 });
    expect(toExecutorCondition({ path: 'deps[0].id', eq: null, ne: null, exists: true })).toEqual({ path: 'deps[0].id', exists: true });
    expect(toExecutorCondition({ path: 'deps[0].id', eq: null, ne: '"x"', exists: null })).toEqual({ path: 'deps[0].id', ne: 'x' });
    expect(toExecutorCondition({ path: 'deps[0].id', eq: null, ne: null, exists: null })).toBeNull();
    expect(toExecutorCondition({ path: '  ', eq: '1', ne: null, exists: null })).toBeNull();
    expect(toExecutorCondition(null)).toBeNull();
  });
});

describe('templates instantiate to valid plans', () => {
  const ctx = templateContextFrom({ tz: 'America/New_York', nowIso: '2026-09-05T12:00:00Z', todayKey: '2026-09-05', requestText: 'plan', viewerMemberId: 'mem-1', trips: [{ id: 'trip-1', title: 'Disney', startDate: '2026-10-10', daysUntil: 35 }] });

  it('every template produces a Plan the schema accepts', () => {
    for (const template of allTemplates()) {
      const plan: Plan = instantiateTemplate(template, ctx);
      const parsed = PlanSchema.safeParse(plan);
      expect(parsed.success, template.intent).toBe(true);
      expect(plan.steps.length).toBeLessThanOrEqual(MAX_STEPS);
      for (const step of plan.steps) expect(parseStepInput(step.input).ok, `${template.intent}/${step.key}`).toBe(true);
    }
  });
});
