// Family Intelligence Network — privacy-preserving insight gating (pure, tested).
//
// The Network could surface anonymized, aggregate patterns ("families with kids
// this age often start passport renewals ~6 months before travel"). The ONLY logic
// that ships today is the safety layer that must sit in front of any such feature:
//
//   1. Nothing is shown OR contributed unless the family explicitly opted in.
//   2. Opt-in is granular per scope.
//   3. k-anonymity: an insight is suppressed unless it's backed by at least K
//      distinct families — so nothing can be traced to any one household.
//
// There is intentionally NO cross-family data extraction here or anywhere yet; the
// aggregation pipeline is deferred until the sharing model is signed off. This
// module is the gate that pipeline would have to pass through.

export type ConsentScope = 'timing' | 'benchmarks' | 'recommendations';

export const CONSENT_SCOPES: { key: ConsentScope; label: string; description: string }[] = [
  { key: 'timing', label: 'Timing patterns', description: 'When families typically prepare for common events (renewals, school, travel).' },
  { key: 'benchmarks', label: 'Gentle benchmarks', description: 'How your load/routines compare to similar families — never individuals.' },
  { key: 'recommendations', label: 'Crowd-rated suggestions', description: 'Meals, activities and tips other similar families rate highly.' },
];

/** Minimum distinct families behind any shown insight. Below this, suppress. */
export const K_ANONYMITY_FLOOR = 20;

export type InsightCandidate = {
  id: string;
  scope: ConsentScope;
  title: string;
  detail: string;
  /** Distinct families whose (already anonymized) data support this pattern. */
  cohortSize: number;
};

export type NetworkInsight = InsightCandidate & { confidence: 'high' | 'medium' };

export type ConsentState = { enabled: boolean; scopes: Partial<Record<ConsentScope, boolean>> };

/** True when a cohort is too small to share without risking re-identification. */
export function isSuppressed(cohortSize: number, minCohort: number = K_ANONYMITY_FLOOR): boolean {
  return cohortSize < minCohort;
}

/**
 * The only insights a family may see: opted-in scope + past the k-anonymity floor.
 * If consent is off, returns [] (the family neither sees nor contributes anything).
 */
export function visibleInsights(
  candidates: InsightCandidate[],
  consent: ConsentState,
  minCohort: number = K_ANONYMITY_FLOOR,
): NetworkInsight[] {
  if (!consent.enabled) return [];
  return candidates
    .filter((c) => consent.scopes[c.scope] === true)
    .filter((c) => !isSuppressed(c.cohortSize, minCohort))
    .map((c): NetworkInsight => ({ ...c, confidence: c.cohortSize >= minCohort * 3 ? 'high' : 'medium' }))
    .sort((a, b) => b.cohortSize - a.cohortSize);
}

/** Whether the family is actively contributing (opted in with at least one scope). */
export function isContributing(consent: ConsentState): boolean {
  return consent.enabled && CONSENT_SCOPES.some((s) => consent.scopes[s.key] === true);
}
