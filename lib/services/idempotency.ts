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
// supply the probe that can answer it for its own table.
//
// Since 0256 the tables the AI writes carry `idempotency_key` with a PARTIAL
// unique index on `(family_id, idempotency_key)`, so `keyedProbe` below is the
// probe every one of them should use: it asks the database the exact question
// ("is this call's row already here?") instead of guessing from a natural key,
// and — because the index makes a second insert impossible rather than
// unlikely — the guard can treat a losing race as a success and hand back the
// row the winner wrote. Tables without the column (recipes, announcements,
// service records) keep a natural-key probe; the guard is the same either way.
import 'server-only';
import { createHash } from 'node:crypto';
import { describeDbError } from '@/lib/supabase/errors';
import type { Database } from '@/lib/database.types';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from './types';

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
 * The `code` a keyed create fails with when its key already wrote a row that no
 * longer matches this request — see `ChangedRetry`. Callers branch on it: the
 * attempt that wrote the row is settled, so the next press is a new
 * composition. `submissionSettled` (lib/utils/submission-id.ts) spells the same
 * string for the browser, which cannot import this server-only module.
 */
export const ALREADY_SAVED = 'already_saved' as const;

/** What a keyed create lets its caller choose. */
export type KeyedCreateOptions = {
  /**
   * Set by a caller whose idempotency key names ONE PERSON'S COMPOSITION — the
   * browser's submission id, held across every press until a row lands. There
   * a found row whose content differs from this request means the person
   * changed something (Today → Tomorrow, a typo fixed) after a press that did
   * land, and answering with that row as a success would say "added" over a
   * change that was dropped. It is answered ALREADY_SAVED instead.
   *
   * Left unset by callers whose key names an OPERATION — an executor step
   * (lib/ai/runs/executor.ts `stepIdempotencyKey`), a per-pet trip task
   * (trips/index.ts `createPetCareTasks`). A retry of a step is the same step
   * even when its recomputed inputs moved (a trip renamed, the default list
   * changed), and the row it already wrote is its outcome, as it always was.
   */
  rejectChangedRetry?: boolean;
};

/**
 * How `withIdempotency` judges a row it found under the key but did not write,
 * for a service whose caller set `rejectChangedRetry`.
 *
 * The key is deliberately content-free (two children each needing "Pack the
 * kit" are two compositions, not one), so it cannot say whether the found row
 * is THIS request. Only a comparison can, and only the service knows which
 * columns it would have written.
 */
export type ChangedRetry<T> = {
  /**
   * The columns on which `found` differs from what this call would write; empty
   * means the same save. Names only — the values are a family's own text and
   * stay out of the log line this feeds.
   */
  drift: (found: T) => string[];
  /**
   * What the person reads. It must hold for a row edited after it landed as
   * well — see `foundUnderKey` — so it names the saved row and says this press
   * added and changed nothing, never that the press carried changes.
   */
  message: (found: T) => Promise<string> | string;
  /** The found row's id, for the operator log line. */
  id: (found: T) => string;
};

/** Two nullable ids, as Postgres compares uuids: case-insensitively, null and undefined alike. */
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

/**
 * Two nullable timestamps, compared as instants. A `timestamptz` comes back in
 * PostgREST's form ("…T19:00:00+00:00") whatever form went in ("…T19:00:00.000Z"),
 * so the TEXT of an unchanged retry never matches its stored row; the instant
 * does. A value that is not a timestamp at all is compared as text.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const [ma, mb] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(ma) && Number.isFinite(mb) ? ma === mb : a === b;
}

/**
 * Run `create` unless `find` says the row is already there.
 *
 * Without `scope.idempotencyKey` there is nothing to deduplicate against and
 * `create` runs directly — a family adding "milk" twice on purpose still gets
 * two rows. A probe that fails is treated as fatal rather than falling through
 * to `create`: a duplicate calendar event or a duplicate charge is worse than
 * an honest "try again", and the caller already knows how to retry.
 *
 * A row found under the key goes through `foundUnderKey`, which hands it back
 * as the success it has always been unless the service asked, through
 * `changedRetry`, for a row that no longer matches this request to be refused.
 */
export async function withIdempotency<T>(
  scope: ServiceScope,
  options: { operation: string; input: unknown; find: IdempotencyProbe<T>; changedRetry?: ChangedRetry<T> },
  create: (key: string | null) => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  if (!scope.idempotencyKey && !scope.runId && !scope.stepId && !scope.requestId) {
    return create(null);
  }
  const key = scopeKey(scope, options.operation, options.input);
  const existing = await options.find(key);
  if (!existing.ok) return existing;
  if (existing.data !== null) return foundUnderKey(scope, options, existing.data);

  const created = await create(key);
  if (created.ok) return created;

  // The probe said no and the insert still failed: on a table with 0256's
  // unique index that is what losing the race looks like, and the row the
  // winner wrote is the honest answer. A failure with nothing behind it is
  // returned unchanged, so a real error is never disguised as success.
  const raced = await options.find(key);
  if (raced.ok && raced.data !== null) return foundUnderKey(scope, options, raced.data);
  return created;
}

/**
 * A row the key already wrote and THIS call did not — by an earlier attempt,
 * or by the call that won the race.
 *
 * Without `changedRetry` it is the success it has always been. With it, the
 * caller's key is a person's submission id (see `KeyedCreateOptions`): a parent
 * who pressed Today, lost the response, and then pressed Tomorrow — or fixed a
 * typo — has sent the same key with different content, and answering with the
 * stored row as a success would tell them "added" while their change is
 * silently discarded. Only an identical retry is the same save.
 *
 * The comparison is with the row AS IT STANDS NOW, not as it was written —
 * nothing records the original content. So a family that edited the row after
 * it landed and then re-sent the unchanged press lands here too, which is why
 * `ChangedRetry.message` must be true for that case as well.
 */
async function foundUnderKey<T>(
  scope: ServiceScope,
  options: { operation: string; changedRetry?: ChangedRetry<T> },
  found: T,
): Promise<ServiceResult<T>> {
  const changed = options.changedRetry;
  if (!changed) return ok(found);
  const fields = changed.drift(found);
  if (fields.length === 0) return ok(found);
  // Field names only: the values are the family's own text.
  console.warn(`[service:idempotency] a retried ${options.operation} does not match the row its key already wrote, as that row stands now`, {
    familyId: scope.familyId, id: changed.id(found), fields,
  });
  return fail(await changed.message(found), { code: ALREADY_SAVED });
}

/** The tables 0256 gave an `idempotency_key` and its partial unique index. */
export const KEYED_TABLES = [
  'calendar_events', 'family_reminders', 'todo_items', 'chore_assignments', 'meal_plans', 'grocery_items',
] as const;
export type KeyedTable = (typeof KEYED_TABLES)[number];

/**
 * WHY the cast: `supabase.from()` is generic over one literal table name, so a
 * union of names yields a union of builders TypeScript will not call. The
 * union above is closed and every query filters `family_id`, so a dynamic name
 * here can still only reach this family's rows — the same argument
 * `lib/ai/runs/verify.ts` makes for its allow-list.
 */
type KeyedReader = {
  from(table: KeyedTable): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          limit(n: number): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
        };
      };
    };
  };
};

/**
 * The probe for a 0256 table: "did this exact call already write its row?".
 *
 * Family-scoped like every other service query — the unique index is per
 * family, and a key is only ever unique within one.
 */
export function keyedProbe<T extends KeyedTable>(
  scope: ServiceScope,
  table: T,
  what: string,
): IdempotencyProbe<Database['public']['Tables'][T]['Row']> {
  return async (key: string) => {
    const reader = scope.db as unknown as KeyedReader;
    const { data, error } = await reader
      .from(table)
      .select('*')
      .eq('family_id', scope.familyId)
      .eq('idempotency_key', key)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[service:idempotency] duplicate probe failed for ${table}`, error);
      return fail(describeDbError(error, `Could not check for a duplicate ${what}.`), { code: SERVICE_CODES.db });
    }
    return ok((data ?? null) as Database['public']['Tables'][T]['Row'] | null);
  };
}
