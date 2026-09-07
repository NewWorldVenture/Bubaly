// lib/metric/count.ts — the ONE error-aware count helper.
//
// WHY THIS FILE EXISTS: every metric surface in this repo used to wrap its
// counts in a private `safeCount` / `cnt` helper that returned 0 when the read
// failed. That is the single most dishonest line of code a product like this
// can ship: "nothing happened this week" and "the database did not answer" are
// different facts, and a family reading "0 things handled" after a Postgres
// outage is being told something untrue about their own household.
//
// `countOrNull` keeps the two apart. `null` means *unavailable*, and every
// caller has to decide what to render for it — which is the point. Nothing here
// swallows an error silently: a failed read is always logged under `[metric]`
// so the outage is visible in the server log even when the surface degrades
// politely.

/** A metric that may not be knowable right now. `null` = the read failed. */
export type MetricCount = number | null;

/** The shape a PostgREST head-count query resolves to. */
type CountQuery = PromiseLike<{ count: number | null; error: unknown }>;

/**
 * Run a `select(..., { count: 'exact', head: true })` query and answer with the
 * count, or `null` when the read failed.
 *
 * `label` names the thing being counted so the log line says which read broke
 * rather than only that one did.
 */
export async function countOrNull(query: CountQuery, label = 'metric'): Promise<MetricCount> {
  const { count, error } = await Promise.resolve(query);
  if (error) {
    console.error(`[metric] ${label} read failed`, error);
    return null;
  }
  return count ?? 0;
}

/** Narrow a metric to a number the UI may render. */
export function isCounted(value: MetricCount): value is number {
  return typeof value === 'number';
}

/**
 * Add counts that together make one number.
 *
 * If ANY part is unavailable the total is unavailable: a sum missing one of its
 * addends is not a smaller true number, it is a wrong one, and a surface that
 * renders it is making the same claim `safeCount` used to.
 */
export function sumCounts(parts: MetricCount[]): MetricCount {
  let total = 0;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
  }
  return total;
}

/**
 * A ratio of two metrics, `null` when either side is unavailable or the
 * denominator is zero. Zero denominators are genuinely undefined — "50% of no
 * families" is not 0%, and a tile that says 0% is lying in the other direction.
 */
export function ratioOrNull(numerator: MetricCount, denominator: MetricCount): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** A percentage 0–100 rounded to a whole number, or `null` when unavailable. */
export function pctOrNull(numerator: MetricCount, denominator: MetricCount): number | null {
  const ratio = ratioOrNull(numerator, denominator);
  return ratio === null ? null : Math.round(ratio * 100);
}
