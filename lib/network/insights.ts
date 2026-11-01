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
// The aggregation pipeline (aggregate.ts + aggregate-server.ts) feeds this gate
// with k-anonymized, DP-noised rows; nothing reaches a family — or the public
// benchmarks page — without passing through it.

export type ConsentScope = 'timing' | 'benchmarks' | 'recommendations';

/** Module-level data: English label plus catalogue keys, so the consent surface renders in the reader's language. */
export const CONSENT_SCOPES: { key: ConsentScope; label: string; labelKey: string; description: string; descriptionKey: string }[] = [
  { key: 'timing', label: 'Timing patterns', labelKey: 'network.scopeTimingPatterns', description: 'When families typically prepare for common events (renewals, school, travel).', descriptionKey: 'network.scopeTimingPatternsDescription' },
  { key: 'benchmarks', label: 'Gentle benchmarks', labelKey: 'network.scopeGentleBenchmarks', description: 'How your load/routines compare to similar families — never individuals.', descriptionKey: 'network.scopeGentleBenchmarksDescription' },
  { key: 'recommendations', label: 'Crowd-rated suggestions', labelKey: 'network.scopeCrowdRatedSuggestions', description: 'Meals, activities and tips other similar families rate highly.', descriptionKey: 'network.scopeCrowdRatedSuggestionsDescription' },
];

/** Minimum distinct families behind any shown insight. Below this, suppress. */
export const K_ANONYMITY_FLOOR = 20;

export type InsightCandidate = {
  id: string;
  scope: ConsentScope;
  title: string;
  detail: string;
  /**
   * DP-noised count of families — the only family count a person may read, and
   * so the only one that grades or ranks an insight.
   */
  count: number;
  /**
   * TRUE distinct families behind the band. SERVER-ONLY: the k-floor reads it
   * and `publishableInsights` drops it, because beside the noised count it is
   * the exact number the noise exists to hide.
   */
  cohortSize: number;
};

/**
 * An insight as it may reach a browser: past the floor, graded and ranked on
 * the noised count, and without the true size. Built field by field in
 * `publishableInsights`, so a field added to the candidate later does not ride
 * along to the client by default.
 */
export type NetworkInsight = Omit<InsightCandidate, 'cohortSize'> & { confidence: 'high' | 'medium' };

export type ConsentState = { enabled: boolean; scopes: Partial<Record<ConsentScope, boolean>> };

/** True when a cohort is too small to share without risking re-identification. */
export function isSuppressed(cohortSize: number, minCohort: number = K_ANONYMITY_FLOOR): boolean {
  return cohortSize < minCohort;
}

/**
 * The server half of the gate: past the k-anonymity floor on the TRUE size,
 * then that size dropped. This is what may be handed to a client component.
 *
 * Confidence and order come from the noised count. Graded on the true size,
 * "high" was a public signal of the exact moment a band crossed 3 × K, and the
 * order of two close bands told which was really larger.
 */
export function publishableInsights(
  candidates: InsightCandidate[],
  minCohort: number = K_ANONYMITY_FLOOR,
): NetworkInsight[] {
  return candidates
    .filter((c) => !isSuppressed(c.cohortSize, minCohort))
    .map((c): NetworkInsight => ({
      id: c.id, scope: c.scope, title: c.title, detail: c.detail, count: c.count,
      confidence: c.count >= minCohort * 3 ? 'high' : 'medium',
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The consent half, over insights already published: opted in, and the scope on.
 * The client re-applies it against the consent row on screen, so a scope
 * switched off hides its insights at once.
 */
export function consentedInsights(insights: NetworkInsight[], consent: ConsentState): NetworkInsight[] {
  if (!consent.enabled) return [];
  return insights.filter((i) => consent.scopes[i.scope] === true);
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
  return consentedInsights(publishableInsights(candidates, minCohort), consent);
}

/** Whether the family is actively contributing (opted in with at least one scope). */
export function isContributing(consent: ConsentState): boolean {
  return consent.enabled && CONSENT_SCOPES.some((s) => consent.scopes[s.key] === true);
}
