import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate, type Messages } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, messages: {} as Messages,
  stats: { families: 0, members: 0, tasksCompleted: 0, handledCompleted: 80, handled30d: 30, familiesWithRuns: 20 },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(state.messages, key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault(state.locale) }),
}));
vi.mock('@/lib/marketing/stats', () => ({ getPublicStats: async () => state.stats }));
vi.mock('@/lib/marketing/seo', () => ({ resolveMarketingMetadata: vi.fn() }));
// These independent async sections do not render the aggregate being checked.
vi.mock('@/components/marketing/marketing-aeo-section', () => ({ MarketingAeoSection: () => null }));
vi.mock('@/components/marketing/trust-ledger', () => ({ TrustLedger: () => null }));

import { HandledLedger } from '@/components/marketing/handled-ledger';
import { PricingValueBlock } from '@/components/marketing/pricing-value-block';
import SecurityPage from '@/app/(marketing)/security/page';
import { realHandledCounts } from '@/lib/marketing/value';
import { handledNote } from '@/lib/marketing/format';

const LOCALES = [
  ['en-US', 'partly complete'], ['de-DE', 'teilweise abgeschlossen'],
  ['es-ES', 'parcialmente completas'], ['fr-FR', 'partiellement terminées'],
  ['it-IT', 'parzialmente complete'], ['nl-NL', 'gedeeltelijk voltooid'],
  ['pt-PT', 'parcialmente concluídas'],
] as const;

function render(node: ReactNode) {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(state.locale), source: 'cookie', messages: state.messages,
  } as Parameters<typeof LocaleProvider>[0], node));
}
function escaped(text: string) {
  return renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
}
async function surfaces() {
  return [
    ['homepage', render(await HandledLedger())],
    ['pricing', render(createElement(PricingValueBlock, { handled: state.stats, sample: { today: 3, clashes: 1, handled: 3, minutes: 15 } }))],
    ['security', render(await SecurityPage())],
  ];
}

describe.each(LOCALES)('public aggregate rendering in %s', (locale, partialPhrase) => {
  it('shows partial-run meaning and the counting method beside every public total', async () => {
    state.locale = locale;
    state.messages = getMessages(locale);
    state.stats.handledCompleted = 80;
    state.stats.handled30d = 30;
    const total = translate(state.messages, 'handledProof.aggregateNote', { count: '80' });
    const method = translate(state.messages, 'pricingValue.realFootnote');
    const recent = translate(state.messages, 'handledProof.aggregate30d', { count: '30' });
    expect(total).toContain(partialPhrase);
    expect(total).not.toContain('things finished');
    expect(total).toContain('80');
    expect(method.length).toBeGreaterThan(60);
    for (const [name, html] of await surfaces()) {
      expect(html, name).toContain(escaped(total));
      expect(html, name).toContain(escaped(method));
      expect(html, name).not.toContain('handledProof.aggregate');
      expect(html, name).not.toContain('pricingValue.realFootnote');
      if (name !== 'security') expect(html, name).toContain(escaped(recent));
    }
  });

  it('hides the run aggregate and its method below the same public floor', async () => {
    state.locale = locale;
    state.messages = getMessages(locale);
    state.stats.handledCompleted = 24;
    state.stats.handled30d = 20;
    const method = translate(state.messages, 'pricingValue.realFootnote');
    const total = translate(state.messages, 'handledProof.aggregateNote', { count: '24' });
    for (const [name, html] of await surfaces()) {
      expect(html, name).not.toContain(escaped(total));
      expect(html, name).not.toContain(escaped(method));
    }
  });
});

describe('public formatter boundaries', () => {
  it.each([25.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '30', true])('does not publish malformed counts: %j', (value) => {
    const n = value as number;
    const t = (key: string) => key;
    expect(handledNote(t, n)).toBe('');
    expect(realHandledCounts({ handledCompleted: n, handled30d: 25 })).toBeNull();
    expect(realHandledCounts({ handledCompleted: 80, handled30d: n })).toEqual({ total: '80', last30d: null });
  });

  it('hides an impossible recent subset while preserving a valid total', () => {
    expect(realHandledCounts({ handledCompleted: 80, handled30d: 81 })).toEqual({ total: '80', last30d: null });
  });
});
