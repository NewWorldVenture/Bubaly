import type { PurchaseAdvice } from './advisor';

type Translate = (key: string, values?: Record<string, string | number>) => string;
const REASONS = {
  over_budget: 'beforeYouBuy.thisWouldTakeTheBudget', owned_duplicate: 'beforeYouBuy.youAlreadyOwnSomethingThat',
  already_purchased: 'beforeYouBuy.someoneHasAlreadyBoughtThis', budget_tight: 'beforeYouBuy.itFitsButWouldLeave',
  no_budget: 'beforeYouBuy.noBudgetCoversThisSo', clear: 'purchaseAdvice.reviewRecords',
};
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** The full deterministic answer travels through Ask, not a run's trimmed log. */
export function purchaseAnswer(text: string, advice: PurchaseAdvice, budgetRestricted: boolean, memoryRestricted: boolean, t: Translate): string {
  const lines = [`${t('beforeYouBuy.beforeYouBuy')}: ${text}`, t(REASONS[advice.reason], { category: advice.budget?.category ?? '' })];
  const section = (title: string, values: string[]) => {
    if (values.length) lines.push('', t(title), ...values.map((value) => `• ${value}`));
  };
  const describe = (row: PurchaseAdvice['duplicates'][number]) =>
    [row.name, row.brand, row.model, row.detail].filter(Boolean).join(' · ');
  section('beforeYouBuy.youAlreadyOwn', advice.duplicates.map(describe));
  section('beforeYouBuy.checkItFitsWhatYou', advice.compatibility.map(describe));
  section('beforeYouBuy.whatYouToldUs', advice.preferences.map((row) => `${row.label}: ${row.value}`));
  section('beforeYouBuy.alreadyOnAWishList', advice.alreadyOnList.map((row) => `${row.title}${row.purchased ? ` · ${t('beforeYouBuy.alreadyBought')}` : ''}`));
  lines.push('', t('beforeYouBuy.budget'));
  if (budgetRestricted) lines.push(t('beforeYouBuy.theHouseholdBudgetIsPrivate'));
  else if (!advice.budget) lines.push(t('purchaseAdvice.addPrice'));
  else if (advice.budget.unbudgeted) lines.push(t('beforeYouBuy.noBudgetCoversThisPurchase', { amount: money(advice.priceCents ?? 0) }));
  else lines.push(t('beforeYouBuy.spentOfLimitUsedLeftAfter', {
    category: advice.budget.category, spent: money(advice.budget.spentCents), limit: money(advice.budget.limitCents), remaining: money(advice.budget.remainingAfterCents),
  }));
  if (memoryRestricted) lines.push('', t('purchaseAdvice.memoryOff'));
  return lines.join('\n');
}
