// lib/ai/schema-to-json.ts — a bounded zod → JSON Schema converter for OpenAI
// `response_format: {type:'json_schema', json_schema:{strict:true}}`.
//
// WHY this exists instead of the `zod-to-json-schema` package: adding a runtime
// dependency is the owner's call, and the planner only needs a small, well
// understood slice of JSON Schema (object / array / string / number / boolean /
// enum / literal / union-of-literals / optional / nullable / describe). A
// converter we own is also the only way to guarantee the two invariants OpenAI's
// strict mode enforces and the spec (§5) depends on:
//
//   1. every object carries `additionalProperties: false`, and
//   2. every key of every object appears in `required`.
//
// Strict mode has no notion of an absent key, so optionality is expressed by
// making the value nullable. That collides with zod: `z.string().optional()`
// accepts `undefined` but REJECTS `null`, so a schema-faithful model response
// would fail `safeParse` for a reason the model can never fix. `conformNulls`
// closes that gap by walking the zod type alongside the decoded JSON and turning
// `null` into `undefined` exactly where the schema accepts undefined and not
// null — before validation, and without touching genuinely nullable fields.
//
// Anything outside the supported subset throws `UnsupportedSchemaError` rather
// than silently emitting a schema that would not match the zod type: a wrong
// schema fails at request time in production, a throw fails in the test that
// first uses the unsupported node.

import type { ZodTypeAny } from 'zod';

export type JsonSchema = Record<string, unknown>;

/** Thrown when a zod node has no faithful representation in the supported subset. */
export class UnsupportedSchemaError extends Error {
  constructor(readonly typeName: string, readonly path: string) {
    super(`Unsupported zod type ${typeName || 'unknown'} at ${path || '<root>'} — extend lib/ai/schema-to-json.ts`);
    this.name = 'UnsupportedSchemaError';
  }
}

type ZodDef = {
  typeName?: string;
  description?: string;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  values?: string[] | Record<string, string | number>;
  value?: unknown;
  options?: ZodTypeAny[];
  checks?: { kind: string }[];
};

function defOf(t: ZodTypeAny): ZodDef {
  return (t as unknown as { _def: ZodDef })._def ?? {};
}

function typeNameOf(t: ZodTypeAny): string {
  return defOf(t).typeName ?? '';
}

/** The single wrapped type of ZodOptional / ZodNullable / ZodDefault. */
function innerOf(t: ZodTypeAny): ZodTypeAny | null {
  const d = defOf(t);
  return (d.innerType ?? null) as ZodTypeAny | null;
}

/** True when the type itself validates `null` (so a null must be preserved). */
function acceptsNull(t: ZodTypeAny): boolean {
  const name = typeNameOf(t);
  if (name === 'ZodNullable' || name === 'ZodNull' || name === 'ZodAny' || name === 'ZodUnknown') return true;
  if (name === 'ZodOptional' || name === 'ZodDefault') {
    const inner = innerOf(t);
    return inner ? acceptsNull(inner) : false;
  }
  if (name === 'ZodUnion' || name === 'ZodDiscriminatedUnion') {
    return unionOptions(t).some(acceptsNull);
  }
  return false;
}

function unionOptions(t: ZodTypeAny): ZodTypeAny[] {
  const d = defOf(t);
  const raw = d.options as ZodTypeAny[] | Map<unknown, ZodTypeAny> | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : Array.from(raw.values());
}

/** Add `null` to an already-converted node, including inside `enum` and `anyOf`. */
function makeNullable(json: JsonSchema): JsonSchema {
  const next: JsonSchema = { ...json };
  if (Array.isArray(next.anyOf)) {
    const options = next.anyOf as JsonSchema[];
    if (!options.some((o) => o.type === 'null')) next.anyOf = [...options, { type: 'null' }];
    return next;
  }
  const type = next.type;
  if (typeof type === 'string') next.type = type === 'null' ? 'null' : [type, 'null'];
  else if (Array.isArray(type)) next.type = type.includes('null') ? type : [...type, 'null'];
  else next.type = 'null';
  if (Array.isArray(next.enum) && !(next.enum as unknown[]).includes(null)) {
    next.enum = [...(next.enum as unknown[]), null];
  }
  return next;
}

function literalSchema(value: unknown, path: string): JsonSchema {
  if (typeof value === 'string') return { type: 'string', enum: [value] };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number', enum: [value] };
  if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
  if (value === null) return { type: 'null' };
  throw new UnsupportedSchemaError('ZodLiteral', path);
}

function convert(t: ZodTypeAny, path: string): JsonSchema {
  const d = defOf(t);
  const name = d.typeName ?? '';
  const describe = (json: JsonSchema): JsonSchema => (d.description ? { ...json, description: d.description } : json);

  switch (name) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault': {
      const inner = innerOf(t);
      if (!inner) throw new UnsupportedSchemaError(name, path);
      // Optional and defaulted values are emitted as nullable: strict mode has no
      // "may be absent", and conformNulls maps the null back to undefined.
      return describe(makeNullable(convert(inner, path)));
    }
    case 'ZodString':
      return describe({ type: 'string' });
    case 'ZodNumber': {
      const isInt = (d.checks ?? []).some((c) => c.kind === 'int');
      return describe({ type: isInt ? 'integer' : 'number' });
    }
    case 'ZodBoolean':
      return describe({ type: 'boolean' });
    case 'ZodNull':
      return describe({ type: 'null' });
    case 'ZodLiteral':
      return describe(literalSchema(d.value, path));
    case 'ZodEnum': {
      const values = (d.values ?? []) as string[];
      if (!Array.isArray(values) || values.length === 0) throw new UnsupportedSchemaError(name, path);
      return describe({ type: 'string', enum: [...values] });
    }
    case 'ZodNativeEnum': {
      const values = Object.values((d.values ?? {}) as Record<string, string | number>);
      if (!values.length || values.some((v) => typeof v !== 'string')) throw new UnsupportedSchemaError(name, path);
      return describe({ type: 'string', enum: values as string[] });
    }
    case 'ZodArray': {
      const element = (d.type ?? null) as ZodTypeAny | null;
      if (!element) throw new UnsupportedSchemaError(name, path);
      return describe({ type: 'array', items: convert(element, `${path}[]`) });
    }
    case 'ZodObject': {
      const shape = typeof d.shape === 'function' ? d.shape() : {};
      const keys = Object.keys(shape);
      const properties: Record<string, JsonSchema> = {};
      for (const key of keys) properties[key] = convert(shape[key], path ? `${path}.${key}` : key);
      // strict mode: every key required, no extra keys.
      return describe({ type: 'object', properties, required: keys, additionalProperties: false });
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = unionOptions(t);
      if (!options.length) throw new UnsupportedSchemaError(name, path);
      const literals = options.filter((o) => typeNameOf(o) === 'ZodLiteral');
      if (literals.length === options.length) {
        // A union of same-typed literals collapses to a single enum, which the
        // model follows far more reliably than an anyOf of one-value branches.
        const values = literals.map((o) => defOf(o).value);
        const kinds = new Set(values.map((v) => (typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v)));
        if (kinds.size === 1) {
          const kind = [...kinds][0];
          if (kind === 'string' || kind === 'integer' || kind === 'number' || kind === 'boolean') {
            return describe({ type: kind, enum: values });
          }
        }
      }
      return describe({ anyOf: options.map((o, i) => convert(o, `${path}|${i}`)) });
    }
    default:
      throw new UnsupportedSchemaError(name, path);
  }
}

/**
 * Convert a zod schema to the strict JSON Schema OpenAI accepts. The root must be
 * an object — strict `json_schema` responses are always objects — so a non-object
 * root is rejected here rather than by the provider at request time.
 */
export function zodToStrictJsonSchema(schema: ZodTypeAny): JsonSchema {
  const json = convert(schema, '');
  if (json.type !== 'object') {
    throw new UnsupportedSchemaError(typeNameOf(schema) || 'non-object root', '<root>');
  }
  return json;
}

/**
 * Walk `value` against `schema` and replace `null` with `undefined` wherever the
 * schema accepts undefined but not null — the exact shape a strict `json_schema`
 * response takes for an `.optional()` field. Returns a new value; the input is
 * never mutated. Unknown types and unknown object keys are passed through
 * untouched so zod (not this function) decides whether they are valid.
 */
export function conformNulls(schema: ZodTypeAny, value: unknown): unknown {
  const name = typeNameOf(schema);
  switch (name) {
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = innerOf(schema);
      if (!inner) return value;
      if (value === null && !acceptsNull(inner)) return undefined;
      return conformNulls(inner, value);
    }
    case 'ZodNullable': {
      const inner = innerOf(schema);
      if (value === null || !inner) return value;
      return conformNulls(inner, value);
    }
    case 'ZodObject': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      const shape = typeof defOf(schema).shape === 'function' ? defOf(schema).shape!() : {};
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(source)) {
        const child = shape[key];
        if (!child) { out[key] = raw; continue; }
        const conformed = conformNulls(child, raw);
        // Dropping the key entirely (rather than setting undefined) keeps
        // `.strict()` schemas and Object.keys checks honest.
        if (conformed !== undefined) out[key] = conformed;
      }
      return out;
    }
    case 'ZodArray': {
      if (!Array.isArray(value)) return value;
      const element = (defOf(schema).type ?? null) as ZodTypeAny | null;
      if (!element) return value;
      return value.map((item) => conformNulls(element, item));
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      for (const option of unionOptions(schema)) {
        const conformed = conformNulls(option, value);
        if (option.safeParse(conformed).success) return conformed;
      }
      return value;
    }
    default:
      return value;
  }
}
