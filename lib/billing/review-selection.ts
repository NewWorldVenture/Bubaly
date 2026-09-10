import { safeInternalRedirect } from '@/lib/auth/redirect';

export type ReviewPlan = 'basic_monthly' | 'basic_annual' | 'plus_monthly' | 'plus_annual';
type Query = Pick<URLSearchParams, 'getAll'>;
export type AuthSelection = { next: string | null; reviewPlan: ReviewPlan | null };

export function isReviewPlan(value: unknown): value is ReviewPlan {
  return value === 'basic_monthly' || value === 'basic_annual' || value === 'plus_monthly' || value === 'plus_annual';
}

/** A navigation hint only: malformed or competing choices never imply a plan. */
export function parseReviewSelection(query: Query): ReviewPlan | null {
  const reviews = query.getAll('reviewPlan');
  const plans = query.getAll('plan');
  const intervals = query.getAll('billing');
  if (query.getAll('checkout').length) return null;
  if (reviews.length) {
    return reviews.length === 1 && plans.length === 0 && intervals.length === 0 && isReviewPlan(reviews[0])
      ? reviews[0] : null;
  }
  if (plans.length !== 1 || intervals.length !== 1) return null;
  const plan = plans[0];
  const interval = intervals[0];
  if ((plan !== 'basic' && plan !== 'plus') || (interval !== 'monthly' && interval !== 'yearly')) return null;
  return `${plan}_${interval === 'yearly' ? 'annual' : 'monthly'}`;
}

export function reviewOnboardingPath(plan: ReviewPlan): string {
  return isReviewPlan(plan) ? `/onboarding?reviewPlan=${plan}` : '/onboarding';
}

export function reviewBillingPath(plan: ReviewPlan): string {
  return isReviewPlan(plan) ? `/dashboard/billing?view=manage&reviewPlan=${plan}` : '/dashboard/billing?view=manage';
}

/** An invite or another single safe explicit return path wins over pricing. */
export function resolveAuthSelection(query: Query, redirectKey: 'redirect' | 'next' = 'redirect'): AuthSelection {
  const redirects = query.getAll(redirectKey);
  // Ambiguous explicit destinations must not quietly become a pricing detour.
  if (redirects.length > 1) return { next: null, reviewPlan: null };
  const explicit = safeInternalRedirect(redirects[0], '');
  if (explicit) return { next: explicit, reviewPlan: null };
  const reviewPlan = parseReviewSelection(query);
  return { next: reviewPlan ? reviewOnboardingPath(reviewPlan) : null, reviewPlan };
}

/** Auth-screen links contain one flat choice or one sanitized explicit path. */
export function authScreenHref(screen: '/login' | '/signup', selection: AuthSelection, authError = false): string {
  const query = new URLSearchParams();
  if (authError) query.set('error', 'auth');
  if (isReviewPlan(selection.reviewPlan) && selection.next === reviewOnboardingPath(selection.reviewPlan)) {
    query.set('reviewPlan', selection.reviewPlan);
  } else {
    const next = safeInternalRedirect(selection.next, '');
    if (next) query.set('redirect', next);
  }
  const suffix = query.toString();
  return suffix ? `${screen}?${suffix}` : screen;
}
