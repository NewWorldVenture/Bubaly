import { buildOutcomePlan, EMPTY_CONTEXT, outcomesForRoute, type Outcome, type OutcomeContext, type OutcomeId } from './launcher';

/** Missing means this surface does not read the source; null means it failed.
 * Only complete, known counts can influence ranking or appear as evidence. */
export type DiscoverySnapshot = Partial<Record<keyof OutcomeContext | 'eventsRemaining' | 'overdueChores' | 'unplannedDinners' | 'expiringDocuments', number | null>>;
type Signal = keyof DiscoverySnapshot;
const SIGNALS: Record<OutcomeId, { signal: Signal; labelKey: string }[]> = {
  run_today: [{ signal: 'overdueTasks', labelKey: 'outcomeDiscovery.overdueTasks' }, { signal: 'overdueChores', labelKey: 'outcomeDiscovery.overdueChores' }, { signal: 'eventsToday', labelKey: 'outcomeDiscovery.eventsToday' }, { signal: 'eventsRemaining', labelKey: 'outcomeDiscovery.eventsRemaining' }],
  feed_family: [{ signal: 'openGrocery', labelKey: 'outcomeDiscovery.openGrocery' }, { signal: 'unplannedDinners', labelKey: 'outcomeDiscovery.unplannedDinners' }],
  celebrate: [{ signal: 'birthdaysSoon', labelKey: 'outcomeDiscovery.birthdaysSoon' }],
  prepare_unexpected: [{ signal: 'expiringDocuments', labelKey: 'outcomeDiscovery.expiringDocuments' }],
  plan_trip: [], prepare_school: [], manage_money: [], stay_healthy: [],
};
export type OutcomeSuggestion = { outcome: Outcome; stepCount: number; evidence: { count: number; labelKey: string }[] };

export function countFromResult(result: { count?: number | null; error?: unknown }): number | null {
  return !result.error && typeof result.count === 'number' && Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : null;
}

/** A filtered subset count is valid only when all matching rows were read. */
export function countMatchingResult<T>(result: { data: T[] | null; count?: number | null; error?: unknown }, matches: (row: T) => boolean): number | null {
  const count = countFromResult(result);
  return count !== null && result.data && result.data.length === count ? result.data.filter(matches).length : null;
}

export function discoverOutcomes(href: string, snapshot: DiscoverySnapshot, limit = 3): { suggestions: OutcomeSuggestion[]; unavailable: boolean } {
  const context: OutcomeContext = { ...EMPTY_CONTEXT };
  for (const key of Object.keys(context) as (keyof OutcomeContext)[]) {
    const count = snapshot[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) context[key] = count;
  }
  const suggestions = outcomesForRoute(href).map((outcome) => ({
    outcome, stepCount: buildOutcomePlan(outcome.id, context).length,
    evidence: SIGNALS[outcome.id].flatMap(({ signal, labelKey }) => {
      const count = snapshot[signal];
      return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? [{ count, labelKey }] : [];
    }),
  })).sort((a, b) => Number(b.evidence.length > 0) - Number(a.evidence.length > 0));
  return {
    suggestions: suggestions.slice(0, Math.max(0, Math.floor(limit))),
    unavailable: Object.values(snapshot).some((count) => count === null || (count !== undefined && (!Number.isSafeInteger(count) || count < 0))),
  };
}
