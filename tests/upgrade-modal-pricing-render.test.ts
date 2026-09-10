import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradeModal } from '@/components/app/upgrade-modal';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

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
const tiers = [
  { level: 1, monthly: '$12.04', equivalent: '$9.99', annual: '$119.88' },
  { level: 2, monthly: '$30.11', equivalent: '$24.99', annual: '$299.88' },
];

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
  it.each(tiers)('shows tier $level annual charge alongside its monthly equivalent before checkout', ({ level, monthly, equivalent, annual }) => {
    const messages = getMessages(locale);
    const template = getRawMessages(locale)['upgradeModal.billedAnnually'];
    expect(template, 'each primary locale supplies its own annual billing disclosure').toContain('{amount}');
    const disclosure = escaped(template.replace('{amount}', annual));
    const html = render(locale, level);
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const annualButton = buttons.find((button) => button.includes(escaped(messages['upgradeModal.chooseAnnual'])));
    const monthlyButton = buttons.find((button) => button.includes(escaped(messages['upgradeModal.chooseMonthly'])));

    expect(annualButton).toBeDefined();
    expect(annualButton).toContain(`${equivalent}<span`);
    expect(annualButton).toContain(disclosure);
    expect(annualButton!.indexOf(disclosure)).toBeLessThan(annualButton!.indexOf(escaped(messages['upgradeModal.chooseAnnual'])));
    expect(monthlyButton).toContain(`${monthly}<span`);
    expect(monthlyButton).not.toContain(disclosure);
    expect(html).not.toContain('upgradeModal.billedAnnually');
    expect(html).not.toContain('{amount}');
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
