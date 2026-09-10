import { BASIC_ANNUAL_CENTS, BASIC_MONTHLY_CENTS, PLUS_ANNUAL_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { MODELED_MINUTES_PER_COMPLETED_PLAN } from './completed-plans-model';

export const DEFAULT_HOURLY_VALUE_USD = 25;
export const VALUE_WINDOW_DAYS = 7;
export const ESTIMATED_MINUTES_PER_COMPLETED_RUN = MODELED_MINUTES_PER_COMPLETED_PLAN;
const DAYS_PER_YEAR = 365.25;

/** Published price allocation, not the household's invoice or amount paid. */
export function annualListPriceCents(plan: string): number | null {
  switch (plan) {
    case 'basic': case 'family': return BASIC_MONTHLY_CENTS * 12;
    case 'basic_annual': case 'family_annual': return BASIC_ANNUAL_CENTS;
    case 'plus': return PLUS_MONTHLY_CENTS * 12;
    case 'plus_annual': return PLUS_ANNUAL_CENTS;
    case 'free': return 0;
    default: return null;
  }
}

export type FamilyValueResult =
  | { state: 'available'; completedRuns: number; undatedCompletedRuns: number; annualListCents: number }
  | { state: 'ineligible' }
  | { state: 'unavailable' };

/** Both sides cover seven days. No cash savings or monthly extrapolation. */
export function compareEstimatedTimeValue(minutes: number, hourlyValueUsd: number, annualListCents: number) {
  if (![minutes, hourlyValueUsd, annualListCents].every(Number.isFinite)
    || minutes < 0 || hourlyValueUsd < 0 || hourlyValueUsd > 1000 || annualListCents <= 0) return null;
  const estimatedValueCents = minutes / 60 * hourlyValueUsd * 100;
  const periodListCents = annualListCents / DAYS_PER_YEAR * VALUE_WINDOW_DAYS;
  if (!Number.isFinite(estimatedValueCents)) return null;
  return { estimatedValueCents, periodListCents, ratio: estimatedValueCents / periodListCents };
}
