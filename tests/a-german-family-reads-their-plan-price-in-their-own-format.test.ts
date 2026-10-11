// AQ-01 / I18N-003, the billing-and-pricing group: every plan price a family is
// shown — on /pricing, in the upgrade modal, on the trial paywall, in the plan
// manager on /dashboard/billing, and in that page's service-fee disclosure — used
// to be `$${(cents / 100).toFixed(2)}`. The `$` was TEXT and toFixed has no locale,
// so a German parent read "$119.88/yr" where their own convention is "119,88 $".
//
// What is pinned here is what the reader SEES: each surface is rendered (or, for
// the server page, called) with a de-DE reader and must show German separators
// with the symbol where German puts it — and the same surface for an en-US
// reader must still read "$119.88". Nothing below inspects source text.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { LOCALE_COOKIE, localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';
import { annualSavingsPct } from '@/lib/billing/plans';

const state = vi.hoisted(() => ({ cookieLocale: 'de-DE' }));

// THE PROSE IS READ FROM THE REAL CATALOGUES, AND NOTHING HERE STANDS IN FOR IT.
// This change moved the English around each amount into catalogue keys
// (pricingValue.perMonthSuffix, pricingContent.billedPerYearSave,
// billing.pricePerYearSave, billing.serviceFeeAddedAtCheckout,
// trialPaywallGate.pricePerYear). Until those keys are merged into
// lib/i18n/messages/*.json — the catalogue merge for this change, which lands in
// the same commit — the cases that read them are RED, in en-US too. That is the
// point: a missing key renders as the key itself, and a German number inside an
// English sentence is the very defect this file is about, so both must fail here.
// `ownSentence` below is what makes the German assertions mean German: the key
// must be in de-DE's OWN catalogue (not inherited from en-US) and must not be the
// English copied across.

// ── Browser and session boundaries the rendered components reach for ──────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`unexpected redirect to ${to}`); },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ role: 'parent', familyId: 'family-a' }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: () => {}, success: () => {} }) }));
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement('section', null, children) : null),
}));
vi.mock('@/components/billing/family-delivered-value', () => ({ FamilyDeliveredValue: () => null }));
vi.mock('@/components/billing/family-value-comparison', () => ({ FamilyValueComparison: () => null }));
vi.mock('@/components/auth/sign-out-form', () => ({ SignOutForm: () => null }));
vi.mock('@/app/(app)/account/actions', () => ({ closeAccountAction: async () => ({ ok: true }) }));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({
  createSavingsGoalAction: async () => ({ ok: true }), createTransactionAction: async () => ({ ok: true }),
  deleteBudgetAction: async () => ({ ok: true }), deleteSavingsGoalAction: async () => ({ ok: true }),
  deleteTransactionAction: async () => ({ ok: true }), setBudgetAction: async () => ({ ok: true }),
}));

// ── The billing page's server side. The LOCALE is not mocked: the real
// getLocaleContext() reads the request cookie, exactly as it does in production.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: state.cookieLocale } : undefined) }),
  headers: async () => new Headers(),
}));
// The billing page asks the guest gate (held 0509) which role the active membership has.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-a' }, active: { role: 'parent' } }) }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => undefined }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { enabled: true, service_fee_cents: 90, service_fee_price_id: 'price_fee_fixture' }, error: null,
    }) }) }) }),
  }),
}));
vi.mock('@/components/modules/finances-module', () => ({ FinancesModule: () => null }));
vi.mock('@/components/app/close-account-card', () => ({ CloseAccountCard: () => null }));

const { UpgradeModal } = await import('@/components/app/upgrade-modal');
const { TrialPaywallGate } = await import('@/components/app/trial-paywall-gate');
const { PricingContent } = await import('@/app/(marketing)/pricing/pricing-content');
const { PlanManager, BillingModule } = await import('@/components/modules/billing-module');
const { default: BillingPage } = await import('@/app/(app)/dashboard/billing/page');
const { formatServiceFee } = await import('@/lib/stripe/service-fee');

function render(locale: LocaleCode, node: ReactElement): string {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
  } as Parameters<typeof LocaleProvider>[0], node));
}

// Expected money is what the shared formatter (lib/wallet/ledger.ts formatCents)
// produces for an EXPLICIT locale in the plans' currency, USD — not a hand-typed
// literal. The first case below pins that a reader locale really does spell it
// differently from en-US, so these expectations cannot quietly all be American.
const money = (locale: LocaleCode, cents: number) => formatCents(cents, 'USD', locale);
const usd = (cents: number) => money('en-US', cents);

// Each tier's yearly charge and the saving the page states beside it.
const ANNUAL_SAVINGS: [number, number][] = [[11988, annualSavingsPct(1)], [29988, annualSavingsPct(2)]];

/**
 * `key` as the locale's OWN catalogue words it: present in that locale's file
 * rather than inherited from en-US through the fallback chain, and — for any
 * locale but en-US — not the English sentence copied across. Without this, an
 * expectation built from getMessages(locale) agrees with whatever the component
 * rendered, including the raw key or the English fallback.
 */
function ownSentence(locale: LocaleCode, key: string): string {
  const own = getRawMessages(locale)[key];
  expect(own, `${locale} carries its own "${key}"`).toBeTruthy();
  if (locale !== 'en-US') {
    expect(own, `${locale}'s "${key}" is translated, not the English`).not.toBe(getRawMessages('en-US')[key]);
  }
  return own;
}

/** The locale's own sentence for `key` with its placeholders filled, escaped as the markup escapes it. */
function sentence(locale: LocaleCode, key: string, params?: Record<string, string | number>): string {
  ownSentence(locale, key);
  return escaped(translate(getMessages(locale), key, params));
}

function escaped(text: string): string {
  return renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
}

/**
 * `price` followed directly by a span whose whole text is `suffix` — the "/mo"
 * beside a price. The price may close its own span first (/pricing wraps it in
 * one; the modal and the plan manager do not).
 */
function priceWithSuffix(price: string, suffix: string): RegExp {
  const lit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${lit(price)}(?:</span>)?<span[^>]*>${lit(suffix)}</span>`);
}

// Every key this change added that a rendered surface can show. None may reach
// the reader as the key itself.
const RAW_KEYS = [
  'pricingValue.perMonthSuffix', 'pricingContent.billedPerYearSave', 'pricingContent.billedMonthly',
  'billing.pricePerYearSave', 'billing.billedMonthly', 'trialPaywallGate.pricePerYear',
];
function expectNoRawKey(html: string): void {
  for (const key of RAW_KEYS) expect(html, `the raw key ${key} reached the reader`).not.toContain(key);
}

describe('a German family reads their plan price in their own format', () => {
  it('money in a reader locale is that locale\'s own spelling, not the American one', () => {
    // The guard that keeps every expectation below from being vacuous. They are
    // built with the shared formatter for an explicit locale, as the component's
    // are; on a Node without full ICU every locale would format like en-US and
    // both sides would agree on "$119.88". German writes the amount first, with a
    // decimal comma and the symbol after it.
    expect(money('de-DE', 11988)).toMatch(/^119,88\s\$$/);
    expect(money('de-DE', 276850)).toMatch(/^2\.768,50\s\$$/);
    expect(money('fr-FR', 11988)).toMatch(/^119,88\s\$US$/);
    expect(money('de-DE', 11988)).not.toBe(money('en-US', 11988));
  });

  it('in the upgrade modal', () => {
    const html = render('de-DE', createElement(UpgradeModal, { open: true, onClose: () => {}, requiredLevel: 1 }));
    for (const cents of [1204, 999, 11988]) expect(html).toContain(money('de-DE', cents));
    // The per-day line, too: ceil(11988 / 365) = 33 cents, ceil(1204 / 30) = 41.
    expect(html).toContain(money('de-DE', 33));
    expect(html).toContain(money('de-DE', 41));
    // "/mo" beside each monthly figure is German's own word for it.
    const perMonth = sentence('de-DE', 'pricingValue.perMonthSuffix');
    expect(html).toMatch(priceWithSuffix(money('de-DE', 1204), perMonth));
    expect(html).toMatch(priceWithSuffix(money('de-DE', 999), perMonth));
    for (const cents of [1204, 999, 11988, 33, 41]) expect(html).not.toContain(money('en-US', cents));
    for (const american of ['33¢', '41¢']) expect(html).not.toContain(american);
    expectNoRawKey(html);
  });

  it('on the trial paywall', () => {
    const html = render('de-DE', createElement(TrialPaywallGate, {}));
    // "{amount}/yr" is German's own sentence around the German amount.
    expect(html).toContain(sentence('de-DE', 'trialPaywallGate.pricePerYear', { amount: money('de-DE', 11988) }));
    expect(html).toContain(sentence('de-DE', 'trialPaywallGate.pricePerYear', { amount: money('de-DE', 29988) }));
    expect(html).not.toContain(money('en-US', 11988));
    expect(html).not.toContain(money('en-US', 29988));
    expectNoRawKey(html);
  });

  it('on the public pricing page', () => {
    const html = render('de-DE', createElement(PricingContent, {}));
    // Yearly is the default period: 11988 / 12 = 9,99 a month, billed 119,88 a year.
    for (const cents of [999, 11988, 2499, 29988, 33]) expect(html).toContain(money('de-DE', cents));
    const perMonth = sentence('de-DE', 'pricingValue.perMonthSuffix');
    expect(html).toMatch(priceWithSuffix(money('de-DE', 999), perMonth));
    expect(html).toMatch(priceWithSuffix(money('de-DE', 2499), perMonth));
    for (const [annual, save] of ANNUAL_SAVINGS) {
      expect(html).toContain(sentence('de-DE', 'pricingContent.billedPerYearSave', { amount: money('de-DE', annual), percent: save }));
    }
    for (const cents of [999, 11988, 2499, 29988, 33]) expect(html).not.toContain(money('en-US', cents));
    expect(html).not.toContain('33¢');
    expectNoRawKey(html);
  });

  it('in the plan manager on the billing page', () => {
    const html = render('de-DE', createElement(PlanManager, { currentSlug: null, pending: false, onChoose: () => {} }));
    for (const cents of [999, 11988, 2499, 29988]) expect(html).toContain(money('de-DE', cents));
    const perMonth = sentence('de-DE', 'pricingValue.perMonthSuffix');
    expect(html).toMatch(priceWithSuffix(money('de-DE', 999), perMonth));
    expect(html).toMatch(priceWithSuffix(money('de-DE', 2499), perMonth));
    for (const [annual, save] of ANNUAL_SAVINGS) {
      expect(html).toContain(sentence('de-DE', 'billing.pricePerYearSave', { amount: money('de-DE', annual), percent: save }));
    }
    for (const cents of [999, 11988, 2499, 29988]) expect(html).not.toContain(money('en-US', cents));
    expectNoRawKey(html);
  });

  it('in the service-fee disclosure the billing page hands the module, in German', async () => {
    state.cookieLocale = 'de-DE';
    const notice = await serviceFeeNotice();
    expect(notice).toContain(money('de-DE', 90));
    expect(notice).not.toContain(money('en-US', 90));
    // The sentence is the German catalogue's OWN — ownSentence fails if de-DE
    // lacks the key or carries the English — with the amount as its placeholder,
    // not an English template literal wrapped around a German number.
    ownSentence('de-DE', 'billing.serviceFeeAddedAtCheckout');
    expect(notice).toBe(translate(getMessages('de-DE'), 'billing.serviceFeeAddedAtCheckout', { amount: money('de-DE', 90) }));
    expect(notice).not.toBe(translate(getMessages('en-US'), 'billing.serviceFeeAddedAtCheckout', { amount: money('de-DE', 90) }));
  });

  it('with German grouping on a four-figure amount, which toFixed never grouped', () => {
    expect(formatServiceFee(276850, 'de-DE')).toBe(money('de-DE', 276850));
    expect(formatServiceFee(276850, 'de-DE')).not.toContain('2768');
  });

  it('and a French one in French', () => {
    const html = render('fr-FR', createElement(TrialPaywallGate, {}));
    // fr-FR writes "$US" after the amount, inside French's own "{amount}/yr".
    expect(html).toContain(sentence('fr-FR', 'trialPaywallGate.pricePerYear', { amount: money('fr-FR', 11988) }));
    expect(html).not.toContain(money('en-US', 11988));
    expectNoRawKey(html);
  });
});

// The English sentences are asserted as English, against the real en-US
// catalogue: red until the catalogue merge for this change lands (see the top).
describe('the same surfaces still read American money to an en-US reader', () => {
  it('in the upgrade modal', () => {
    const html = render('en-US', createElement(UpgradeModal, { open: true, onClose: () => {}, requiredLevel: 1 }));
    for (const cents of [1204, 999, 11988, 33, 41]) expect(html).toContain(usd(cents));
    expect(html).toMatch(priceWithSuffix(usd(1204), '/mo'));
    expect(html).toMatch(priceWithSuffix(usd(999), '/mo'));
    expectNoRawKey(html);
  });

  it('on the trial paywall', () => {
    const html = render('en-US', createElement(TrialPaywallGate, {}));
    expect(html).toContain(`${usd(11988)}/yr`);
    expect(html).toContain(`${usd(29988)}/yr`);
    expectNoRawKey(html);
  });

  it('on the public pricing page', () => {
    const html = render('en-US', createElement(PricingContent, {}));
    expect(html).toMatch(priceWithSuffix(usd(999), '/mo'));
    expect(html).toContain(`billed ${usd(11988)}/yr · save 17%`);
    expect(html).toContain(`billed ${usd(29988)}/yr · save 17%`);
    expectNoRawKey(html);
  });

  it('in the plan manager', () => {
    const html = render('en-US', createElement(PlanManager, { currentSlug: null, pending: false, onChoose: () => {} }));
    expect(html).toMatch(priceWithSuffix(usd(999), '/mo'));
    expect(html).toContain(`${usd(11988)}/yr · save 17%`);
    expect(html).toContain(`${usd(29988)}/yr · save 17%`);
    expectNoRawKey(html);
  });

  it('in the service-fee disclosure', async () => {
    state.cookieLocale = 'en-US';
    expect(await serviceFeeNotice()).toBe(`A one-time ${usd(90)} Bubaly service fee is added at checkout.`);
    expect(formatServiceFee(276850, 'en-US')).toBe(usd(276850));
    expect(usd(276850), 'en-US groups thousands, which toFixed never did').toContain(',');
  });
});

/** Call the real server page for ?view=manage and read the notice it hands BillingModule. */
async function serviceFeeNotice(): Promise<string> {
  const tree = await BillingPage({ searchParams: Promise.resolve({ view: 'manage' }) });
  const found = elements(tree).find((el) => el.type === BillingModule);
  expect(found, 'the manage view renders BillingModule').toBeDefined();
  const notice = (found!.props as { serviceFeeNotice?: string | null }).serviceFeeNotice;
  expect(typeof notice).toBe('string');
  return notice as string;
}

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}
