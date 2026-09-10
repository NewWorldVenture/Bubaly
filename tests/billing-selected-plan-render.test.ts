import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SelectedPlanReview } from '@/components/billing/selected-plan-review';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { PLAN_META, annualSavingsPct } from '@/lib/billing/plans';
import type { ReviewPlan } from '@/lib/billing/review-selection';

const locales: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const plans: ReviewPlan[] = ['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'];
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
function render(locale: LocaleCode, plan: ReviewPlan, currentSlug: string | null = null, pending = false, hasLiveSubscription = false, canceling = false, syncPending = false) {
  const onConfirm = vi.fn();
  const providerProps = {
    locale: localeOrDefault(locale), source: 'default', messages: getMessages(locale),
    children: createElement(SelectedPlanReview, { initialPlan: plan, familyName: 'River & Hill family', currentSlug, pending, hasLiveSubscription, canceling, syncPending, onRefresh: vi.fn(), onConfirm }),
  } satisfies Parameters<typeof LocaleProvider>[0];
  const markup = renderToStaticMarkup(createElement(LocaleProvider, providerProps));
  expect(onConfirm).not.toHaveBeenCalled();
  return markup;
}

describe.each(locales)('real selected-plan renderer in %s', locale => {
  const messages = getMessages(locale);
  const t = (key: string, params?: Record<string, string | number>) => escape(translate(messages, key, params));
  const money = (cents: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
  it.each(plans)('initializes exactly %s with canonical price, current family, fee and explicit confirmation', plan => {
    const meta = PLAN_META[plan];
    const markup = render(locale, plan);
    expect(markup).toContain(`data-review-plan="${plan}"`);
    expect(markup).toContain(t('billingReview.title'));
    expect(markup).toContain(t('billingReview.family', { family: 'River & Hill family' }));
    expect(markup).toContain(t('billingReview.current', { plan: 'Bubaly Free' }));
    expect(markup).toContain(t('billingReview.confirm'));
    expect(markup).toContain(t('billingReview.confirmationRequired'));
    expect(markup).toContain(t('billingReview.noServiceFee'));
    expect(markup).toContain(t(meta.interval === 'annual' ? 'billingReview.annualTotal' : 'billingReview.monthlyTotal', { amount: money(meta.totalCents) }));
    if (meta.interval === 'annual') expect(markup).toContain(t('billingReview.equivalent', { amount: money(meta.monthlyCents), percent: annualSavingsPct(meta.level) }));
    else expect(markup).not.toContain(t('billingReview.equivalent', { amount: money(meta.monthlyCents), percent: annualSavingsPct(meta.level) }));
    expect(markup).not.toContain(t('billingReview.proration'));
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(markup).toContain('href="/dashboard/billing?view=manage"');
    expect(markup).not.toContain('billingReview.');
  });
  it('shows the actual paid current interval, proration, and a disabled current-plan no-op', () => {
    const changed = render(locale, 'plus_annual', 'basic', false, true);
    expect(changed).toContain(t('billingReview.current', { plan: `Family Basic · ${translate(messages, 'billing.monthly')}` }));
    expect(changed).toContain(t('billingReview.prorationImmediate'));
    expect(changed).not.toContain(t('billingReview.proration'));
    expect(render(locale, 'plus_monthly', 'basic', false, true)).toContain(t('billingReview.proration'));
    const current = render(locale, 'plus_annual', 'plus_annual', false, true);
    expect(current).toContain(t('billingReview.currentPlan'));
    expect(current).toContain(t('billingReview.alreadyCurrent'));
    expect(current).toMatch(/<button[^>]+disabled=""[^>]*>/);
    expect(current).not.toContain(t('billingReview.proration'));
  });
  it('disables the selectors and confirmation while a request is pending', () => {
    const markup = render(locale, 'basic_annual', null, true);
    expect(markup.match(/<fieldset disabled=""/g)).toHaveLength(2);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>/);
  });
  it('offers an explicit repurchase for an inactive retained slug and a disclosed scheduled-cancel resume', () => {
    const ended = render(locale, 'plus_annual', 'plus_annual', false, false);
    expect(ended).toContain(t('billingReview.confirm'));
    expect(ended).toContain(t('billingReview.current', { plan: 'Bubaly Free' }));
    expect(ended).not.toContain(t('billingReview.alreadyCurrent'));
    const resume = render(locale, 'plus_annual', 'plus_annual', false, true, true);
    expect(resume).toContain(t('billingReview.resume'));
    expect(resume).toContain(t('billingReview.confirm'));
    expect(resume).not.toContain(t('billingReview.alreadyCurrent'));
  });
  it('keeps a provider-confirmed change disabled while offering a read-only status retry', () => {
    const waiting = render(locale, 'plus_annual', 'basic', false, true, false, true);
    expect(waiting).toContain(t('changePlan.stripeChangedThePlanBut'));
    expect(waiting).toContain(t('billingReview.refreshStatus'));
    expect(waiting.match(/<fieldset disabled=""/g)).toHaveLength(2);
    expect(waiting).not.toContain(t('billingReview.confirmationRequired'));
  });
});
