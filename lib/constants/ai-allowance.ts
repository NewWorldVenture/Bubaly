/**
 * Monthly AI requests per plan level (F19): Free is capped, Basic and Plus are
 * unlimited (`null`). The documentation of what is counted lives beside the
 * check in `lib/server/ai-access.ts`, which re-exports this. It sits here, free
 * of server imports, so `withAiRequest` can tell a capped family from an
 * unlimited one without importing the access module.
 */
export const AI_MONTHLY_ALLOWANCE: Readonly<Record<0 | 1 | 2, number | null>> = { 0: 10, 1: null, 2: null };

/** The allowance for a plan level, clamped to the three levels the plans sell. */
export function monthlyAllowanceFor(planLevel: number): number | null {
  return AI_MONTHLY_ALLOWANCE[planLevel >= 2 ? 2 : planLevel >= 1 ? 1 : 0];
}
