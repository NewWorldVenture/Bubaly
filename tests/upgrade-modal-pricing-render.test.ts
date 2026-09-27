import { at } from './helpers/source-order';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradeModal } from '@/components/app/upgrade-modal';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

const state = vi.hoisted(() => ({ role: 'parent', checkout: vi.fn(), serverRead: vi.fn() }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ role: state.role, familyId: 'family-pricing' }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
// A pending family-value summary can render beside the prices. Its server
// dependencies stay behind the action boundary and must not run during render.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: state.serverRead }));
vi.mock('@/lib/supabase/server', () => ({ createServer: state.serverRead }));
// Render the actual modal contents; the portal and focus trap need a browser
// and are independent of which prices and billing periods a family sees.
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement('section', null, children) : null,
}));

const locales: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
// Cents, not strings: each reader sees the plan's USD price in their OWN money
// format ("12,04 $" in de-DE, "$12.04" in en-US), so the expected text is what
// the shared formatter produces for that EXPLICIT locale. Each case also checks
// that a non-English locale's spelling differs from en-US's, so the expectation
// cannot silently be American everywhere (a Node without full ICU would do that).
const tiers = [
  { level: 1, monthly: 1204, equivalent: 999, annual: 11988 },
  { level: 2, monthly: 3011, equivalent: 2499, annual: 29988 },
];
const money = (locale: LocaleCode, cents: number) => formatCents(cents, 'USD', locale);
const PER_MONTH_KEY = 'pricingValue.perMonthSuffix';

/** `price` immediately followed by a span whose whole text is `suffix` — the "/mo" beside a price. */
function priceWithSuffix(price: string, suffix: string): RegExp {
  const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${lit(price)}<span[^>]*>${lit(suffix)}</span>`);
}

function render(locale: LocaleCode, requiredLevel: number, open = true): string {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
  } as Parameters<typeof LocaleProvider>[0],
  createElement(UpgradeModal, { open, onClose: () => {}, requiredLevel })));
}

function escaped(text: string): string {
  return renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
}

beforeEach(() => {
  state.role = 'parent';
  state.checkout.mockReset();
  state.checkout.mockImplementation(() => { throw new Error('Rendering prices must not start checkout'); });
  state.serverRead.mockReset();
  state.serverRead.mockImplementation(() => { throw new Error('Rendering prices must not read a server session'); });
  vi.stubGlobal('fetch', state.checkout);
});

afterEach(() => {
  expect(state.checkout).not.toHaveBeenCalled();
  expect(state.serverRead).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.each(locales)('upgrade pricing disclosure in %s', (locale) => {
  it.each(tiers)('shows tier $level annual charge alongside its monthly equivalent before checkout', (tier) => {
    const [monthly, equivalent, annual] = [tier.monthly, tier.equivalent, tier.annual].map((cents) => escaped(money(locale, cents)));
    if (locale !== 'en-US') {
      expect(monthly, `${locale} spells money its own way, not as en-US does`).not.toBe(escaped(money('en-US', tier.monthly)));
    }
    const level = tier.level;
    const messages = getMessages(locale);
    const template = getRawMessages(locale)['upgradeModal.billedAnnually'];
    expect(template, 'each primary locale supplies its own annual billing disclosure').toContain('{amount}');
    // "/mo" is catalogue copy too. Red until this change's catalogue merge lands:
    // the raw key would otherwise sit in the span and a bare `${price}<span`
    // check would still pass.
    const perMonth = getRawMessages(locale)[PER_MONTH_KEY];
    expect(perMonth, 'each primary locale supplies its own per-month suffix').toBeTruthy();
    const suffix = escaped(perMonth);
    const disclosure = escaped(template.replace('{amount}', annual));
    const html = render(locale, level);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const annualButton = buttons.find((button) => button.includes(escaped(messages['upgradeModal.chooseAnnual'])));
    const monthlyButton = buttons.find((button) => button.includes(escaped(messages['upgradeModal.chooseMonthly'])));

    expect(annualButton).toBeDefined();
    expect(annualButton).toMatch(priceWithSuffix(equivalent, suffix));
    expect(annualButton).toContain(disclosure);
    expect(at(annualButton!, disclosure)).toBeLessThan(at(annualButton!, escaped(messages['upgradeModal.chooseAnnual'])));
    expect(monthlyButton).toMatch(priceWithSuffix(monthly, suffix));
    expect(monthlyButton).not.toContain(disclosure);
    expect(html).not.toContain('upgradeModal.billedAnnually');
    expect(html).not.toContain(PER_MONTH_KEY);
    expect(html).not.toContain('{amount}');
  });
});

// The English sentences, as English, from the real en-US catalogue — red until
// this change's catalogue merge supplies pricingValue.perMonthSuffix.
describe('an en-US reader still reads American money', () => {
  it.each(tiers)('tier $level', ({ level, monthly, equivalent, annual }) => {
    const html = render('en-US', level);
    expect(html).toMatch(priceWithSuffix(money('en-US', monthly), '/mo'));
    expect(html).toMatch(priceWithSuffix(money('en-US', equivalent), '/mo'));
    expect(html).toContain(`Billed ${money('en-US', annual)} annually`);
    expect(money('en-US', annual)).toMatch(/^\$\d+\.\d{2}$/);
  });
});

describe('upgrade purchase controls remain conditional', () => {
  it.each([1, 2])('keeps tier %i purchase controls hidden from a non-admin', (level) => {
    state.role = 'child';
    const messages = getMessages('en-US');
    const html = render('en-US', level);
    expect(html).toContain(escaped(messages['upgradeModal.askAFamilyAdminToUpgrade']));
    expect(html).not.toContain(escaped(messages['upgradeModal.chooseAnnual']));
    expect(html).not.toContain(escaped(messages['upgradeModal.chooseMonthly']));
  });

  it('renders no prices or purchase controls while closed', () => {
    expect(render('en-US', 1, false)).toBe('');
  });
});
