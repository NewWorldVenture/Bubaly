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

/**
 * The allowance refusal's English source text. The gate, the admission's
 * refusal and the concierge intake all say this one sentence; `denialMessage`
 * (lib/server/ai-access.ts) says it in the reader's language.
 */
export function allowanceUsedText(limit: number): string {
  return `Your family has used its ${limit} AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.`;
}
