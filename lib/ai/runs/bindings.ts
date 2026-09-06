// lib/ai/runs/bindings.ts — how a step names what an earlier step created.
//
// Until now there was no data flow between steps at all. `runToolStep` called
// the tool with `step.input_json` verbatim, and a dependency's `result_json`
// was gathered only to evaluate conditions. So a plan could not say "add the
// packing list TO the trip you just created", and — the sharper cost — a
// verify step could not name the rows the run had just written.
//
// The consequence was that every verify step the templates emit is an
// unfiltered, family-wide `count_at_least` ("at least 5 meal_plans"), which a
// family that already had last week's plan satisfies whether or not this run
// wrote a single row. `lib/ai/runs/verify.ts` implements the strong checks §13
// asks for — `records_exist` with real ids, `fields_match` — and their builders
// had no callers, because nothing could supply an id.
//
// A binding is `{"$fromStep": "<step>", "path": "id"}`. It is resolved against
// the dependency results the executor already has, immediately before the tool
// or the check runs, and a binding that cannot be resolved fails its step
// rather than passing a literal `undefined` to a database.
import type { Json } from '@/lib/database.types';

export const BINDING_KEY = '$fromStep';

export type Binding = { [BINDING_KEY]: string; path: string };

/** A binding is exactly these two keys — anything else is ordinary input. */
export function isBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes(BINDING_KEY) || !keys.includes('path')) return false;
  const record = value as Record<string, unknown>;
  return typeof record[BINDING_KEY] === 'string' && typeof record.path === 'string';
}

/** Every step this value depends on, so a plan's `depends_on` can be checked against it. */
export function bindingSources(value: unknown): string[] {
  const out = new Set<string>();
  walk(value, (binding) => { out.add(binding[BINDING_KEY]); });
  return [...out];
}

/**
 * Rewrite the step names in every binding, for the one moment planner-local
 * keys ("trip") become minted uuids. `dependency_ids` goes through the same map
 * in `lib/ai/runs/store.ts`, and a binding that survived with a key in it would
 * be unresolvable at execution — so an unmapped name is left as it is and
 * caught there, loudly, rather than silently dropped here.
 */
export function remapBindings(value: Json, map: Record<string, string>): Json {
  return transform(value, (binding) => ({
    [BINDING_KEY]: map[binding[BINDING_KEY]] ?? binding[BINDING_KEY],
    path: binding.path,
  })) as Json;
}

export type Resolution =
  | { ok: true; value: Json }
  | { ok: false; error: string };

/**
 * Replace every binding with the value it names.
 *
 * `results` is keyed by step id — the map `runStep` already builds from the
 * dependency ids. A missing step, a missing path, or a null at the end of the
 * path is an error: a step that meant to reference a real row must not run
 * against a hole.
 */
export function resolveBindings(value: Json, results: Record<string, unknown>): Resolution {
  const problems: string[] = [];
  const resolved = transform(value, (binding) => {
    const source = results[binding[BINDING_KEY]];
    if (source === undefined || source === null) {
      problems.push(`the step it depends on produced nothing to read "${binding.path}" from`);
      return null;
    }
    const found = readPath(source, binding.path);
    if (found === undefined || found === null) {
      problems.push(`"${binding.path}" was not in what the step it depends on produced`);
      return null;
    }
    return found as Json;
  });
  if (problems.length) return { ok: false, error: `Bubaly could not use an earlier step's result: ${problems[0]}.` };
  return { ok: true, value: resolved as Json };
}

/** `a.b.0.c` over plain objects and arrays; no wildcards, no expressions. */
function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function walk(value: unknown, visit: (binding: Binding) => void): void {
  if (isBinding(value)) { visit(value); return; }
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return; }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, visit);
  }
}

function transform(value: unknown, replace: (binding: Binding) => unknown): unknown {
  if (isBinding(value)) return replace(value);
  if (Array.isArray(value)) return value.map((item) => transform(item, replace));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, transform(v, replace)]));
  }
  return value;
}
