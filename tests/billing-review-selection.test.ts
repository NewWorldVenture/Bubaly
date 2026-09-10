import { describe, expect, it } from 'vitest';
import { authScreenHref, isReviewPlan, parseReviewSelection, resolveAuthSelection, reviewBillingPath, reviewOnboardingPath, type ReviewPlan } from '@/lib/billing/review-selection';
import { safeInternalRedirect } from '@/lib/auth/redirect';

const cases: [string, ReviewPlan][] = [
  ['plan=basic&billing=monthly', 'basic_monthly'], ['plan=basic&billing=yearly', 'basic_annual'],
  ['plan=plus&billing=monthly', 'plus_monthly'], ['plan=plus&billing=yearly', 'plus_annual'],
];

describe('strict review selection', () => {
  it.each(cases)('normalizes %s into one review hint', (query, plan) => {
    expect(parseReviewSelection(new URLSearchParams(query))).toBe(plan);
    expect(parseReviewSelection(new URLSearchParams({ reviewPlan: plan }))).toBe(plan);
    expect(reviewOnboardingPath(plan)).toBe(`/onboarding?reviewPlan=${plan}`);
    expect(reviewBillingPath(plan)).toBe(`/dashboard/billing?view=manage&reviewPlan=${plan}`);
    const selection = resolveAuthSelection(new URLSearchParams(query));
    expect(selection).toEqual({ next: `/onboarding?reviewPlan=${plan}`, reviewPlan: plan });
    for (const screen of ['/login', '/signup'] as const) {
      const link = authScreenHref(screen, selection);
      expect(link).toBe(`${screen}?reviewPlan=${plan}`);
      expect(resolveAuthSelection(new URL(link, 'https://bubaly.test').searchParams)).toEqual(selection);
    }
  });

  it.each([
    '', 'plan=basic', 'billing=yearly', 'plan=basic&billing=annual', 'plan=family&billing=monthly',
    'plan=basic&billing=monthly&plan=basic', 'plan=basic&billing=monthly&billing=yearly',
    'plan=basic&billing=yearly&billing=yearly', 'plan=PLUS&billing=yearly', 'plan=plus&billing=',
    'reviewPlan=plus_annual&reviewPlan=plus_annual', 'reviewPlan=basic_monthly&reviewPlan=plus_monthly',
    'reviewPlan=plus_annual&plan=plus&billing=yearly', 'reviewPlan=plus_annual&plan=plus',
    'reviewPlan=plus_annual&billing=yearly', 'reviewPlan=plus_annual&checkout=plus',
    'plan=plus&billing=yearly&checkout=', 'reviewPlan=__proto__', 'reviewPlan=constructor',
    'reviewPlan=toString', 'reviewPlan=%7B%22plan%22%3A%22plus%22%7D', 'reviewPlan=plus_monthly,plus_annual',
    'reviewPlan=plus_annual%20', 'reviewPlan=plus_yearly', 'plan=evil&billing=monthly',
  ])('rejects incomplete, duplicate, or competing input %s', (query) => {
    expect(parseReviewSelection(new URLSearchParams(query))).toBeNull();
    expect(resolveAuthSelection(new URLSearchParams(query))).toEqual({ next: null, reviewPlan: null });
  });

  it.each([null, undefined, {}, [], 1, '__proto__', 'constructor', 'basic', 'plus_yearly'])('rejects noncanonical value %j', (value) => {
    expect(isReviewPlan(value)).toBe(false);
  });

  it('does not accept URL amounts, provider IDs, family IDs, or features as purchase state', () => {
    const query = new URLSearchParams('reviewPlan=plus_annual&amount=1&price=price_fake&familyId=other&feature=anything');
    expect(resolveAuthSelection(query)).toEqual({ next: '/onboarding?reviewPlan=plus_annual', reviewPlan: 'plus_annual' });
    expect(authScreenHref('/login', resolveAuthSelection(query))).toBe('/login?reviewPlan=plus_annual');
  });
});

describe('auth destination precedence and safe transport', () => {
  it.each(['/join?token=invite-fixture#accept', '/dashboard/billing?view=manage&section=payment#plan', '/grandparent', '/admin'])('keeps explicit %s ahead of a pricing hint through both screens and callback retry', (next) => {
    const query = new URLSearchParams({ plan: 'plus', billing: 'yearly', redirect: next });
    const selection = resolveAuthSelection(query);
    expect(selection).toEqual({ next, reviewPlan: null });
    for (const screen of ['/login', '/signup'] as const) {
      const link = new URL(authScreenHref(screen, selection), 'https://bubaly.test');
      expect(link.searchParams.get('redirect')).toBe(next);
      expect(link.searchParams.has('reviewPlan')).toBe(false);
      expect(resolveAuthSelection(link.searchParams)).toEqual(selection);
    }
    const callback = new URLSearchParams({ next });
    const retry = new URL(authScreenHref('/login', resolveAuthSelection(callback, 'next'), true), 'https://bubaly.test');
    expect(retry.searchParams.get('error')).toBe('auth');
    expect(resolveAuthSelection(retry.searchParams)).toEqual(selection);
  });

  it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/safe?next=%2fadmin'])('keeps unsafe redirect %s out of links without weakening the sanitizer', (redirect) => {
    expect(safeInternalRedirect(redirect, '')).toBe('');
    const resolved = resolveAuthSelection(new URLSearchParams({ redirect, reviewPlan: 'basic_annual' }));
    expect(resolved.next).toBe('/onboarding?reviewPlan=basic_annual');
    expect(authScreenHref('/login', resolved)).toBe('/login?reviewPlan=basic_annual');
    expect(authScreenHref('/login', { next: redirect, reviewPlan: null })).toBe('/login');
  });

  it.each(['redirect', 'next'] as const)('refuses ambiguous %s destinations rather than selecting the first', (key) => {
    const query = new URLSearchParams(`${key}=/join&${key}=/home&reviewPlan=plus_annual`);
    expect(resolveAuthSelection(query, key)).toEqual({ next: null, reviewPlan: null });
  });

  it('does not replace default role-aware routing with a manufactured destination', () => {
    const empty = resolveAuthSelection(new URLSearchParams());
    expect(empty).toEqual({ next: null, reviewPlan: null });
    expect(authScreenHref('/login', empty, true)).toBe('/login?error=auth');
    expect(authScreenHref('/signup', empty)).toBe('/signup');
  });
});
