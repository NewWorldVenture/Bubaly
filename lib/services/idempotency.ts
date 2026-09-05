// Deterministic keys for "this write must not happen twice", and the guard
// services wrap a create in.
//
// Why a probe callback instead of a ledger table: the duplicate ledger
// (`public.ai_tool_calls`, migration 0250, unique on
// `(family_id, idempotency_key)`) is written by the tool executor
// (`lib/ai/tools/execute.ts`), which wraps the service call. If a service also
// reserved a ledger row under the same key it would collide with its own
// caller on that unique index. So the guard here answers a narrower question —
// "does the row this call would create already exist?" — and lets each service
// supply the probe that can answer it for its own table. Today those probes
// match on the natural key (family + title + instant); when P3-01 adds
// `idempotency_key` columns to the domain tables the probe becomes a lookup on
// that column and nothing else about this guard changes.
import 'server-only';
import { createHash } from 'node:crypto';
import type { ServiceResult, ServiceScope } from './types';

type StableValue = null | boolean | number | string | StableValue[] | { [key: string]: StableValue };

/**
 * Normalise before hashing so that key equality means "the same request", not
 * "the same JSON text": object key order, `undefined` holes and surrounding
 * whitespace must not change the digest.
 */
function stableValue(value: unknown): StableValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return String(value);
}

/**
 * A stable sha256 over normalised parts. `null` and `undefined` are kept as
 * distinct positions rather than dropped, so `makeKey(['a', null, 'b'])` and
 * `makeKey(['a', 'b'])` are different keys — dropping them would let two
 * different requests share a key and silently suppress the second write.
 */
export function makeKey(parts: (string | number | null | undefined)[]): string {
  return createHash('sha256').update(JSON.stringify(parts.map(stableValue))).digest('hex');
}

/**
 * The key for one tool/service call, composed the way migration 0250 documents:
 * executor calls are keyed by run + step so a retried step is deduplicated,
 * while a caller-supplied `scope.idempotencyKey` (set by `/api/ai` from the
 * originating message) wins outright. Same words typed on a later turn produce
 * a different request id and therefore execute again, which is the behaviour a
 * family expects from "add milk".
 */
export function scopeKey(scope: ServiceScope, operation: string, input: unknown): string {
  if (scope.idempotencyKey) return scope.idempotencyKey;
  return makeKey([
    scope.familyId,
    scope.runId ?? null,
    scope.stepId ?? null,
    scope.requestId ?? null,
    operation,
    createHash('sha256').update(JSON.stringify(stableValue(input))).digest('hex'),
  ]);
}

export type IdempotencyProbe<T> = (key: string) => Promise<ServiceResult<T | null>>;

/**
 * Run `create` unless `find` says the row is already there.
 *
 * Without `scope.idempotencyKey` there is nothing to deduplicate against and
 * `create` runs directly — a family adding "milk" twice on purpose still gets
 * two rows. A probe that fails is treated as fatal rather than falling through
 * to `create`: a duplicate calendar event or a duplicate charge is worse than
 * an honest "try again", and the caller already knows how to retry.
 */
export async function withIdempotency<T>(
  scope: ServiceScope,
  options: { operation: string; input: unknown; find: IdempotencyProbe<T> },
  create: (key: string | null) => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  if (!scope.idempotencyKey && !scope.runId && !scope.stepId && !scope.requestId) {
    return create(null);
  }
  const key = scopeKey(scope, options.operation, options.input);
  const existing = await options.find(key);
  if (!existing.ok) return existing;
  if (existing.data !== null) return { ok: true, data: existing.data };
  return create(key);
}
