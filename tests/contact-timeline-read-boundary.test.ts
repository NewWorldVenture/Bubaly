import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContactTimelinePage from '@/app/(app)/dashboard/contacts/[id]/page';
import { draftReconnectMessageAction } from '@/app/(app)/dashboard/contacts/[id]/actions';
import { ContactTimelineReadError } from '@/components/modules/contact-timeline-module';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

type Query = { table: string; filters: [string, string][]; limit?: number };
const h = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, failureTable: '', mode: '', empty: false, missingContact: false,
  queries: [] as Query[], provider: vi.fn(), complete: vi.fn(), ledger: vi.fn(), refresh: vi.fn(), configured: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); }, useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  const { localeOrDefault: locale } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages(h.locale), key, params),
    getLocaleContext: async () => ({ locale: locale(h.locale), source: 'cookie', messages: messages(h.locale) }),
  };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  if (h.failureTable === 'auth') throw new Error('AUTH_REDIRECT');
  return { user: { id: 'user-1' }, active: { familyId: 'family-1' } };
} }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({ familyId: 'family-1', userId: 'user-1' }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  if (h.failureTable === 'client') throw new Error('Client construction failed');
  return { from: (table: string) => {
    if (h.failureTable === table && h.mode === 'throw') throw new Error('Query construction failed');
    const query: Query = { table, filters: [] }; h.queries.push(query);
    const result = () => {
      if (h.failureTable === table) {
        if (h.mode === 'reject') return Promise.reject(new Error('Network failed'));
        if (h.mode === 'null-reject') return Promise.reject(null);
        if (h.mode === 'error') return Promise.resolve({ data: table === 'family_contacts' ? { name: 'Partial record' } : [{ title: 'Partial history' }], error: { message: 'Returned error' } });
        if (h.mode === 'missing') return Promise.resolve({ data: null, error: null });
      }
      const data = table === 'family_contacts'
        ? h.missingContact ? null : { id: 'contact-1', family_id: 'family-1', name: 'Alex', relationship: null, birthday_month: null, birthday_day: null }
        : h.empty ? [] : table === 'contact_interactions'
          ? [{ id: 'one', kind: 'call', occurred_on: '2026-06-01', title: 'Saved call', note: 'Saved detail', amount: null }]
          : [{ id: 'two', channel: 'email', direction: 'inbound', subject: 'Saved email', summary: 'Saved summary', received_at: '2026-06-02T00:00:00Z' }];
      return Promise.resolve({ data, error: null });
    };
    const chain = {
      select: () => chain, eq: (key: string, value: string) => { query.filters.push([key, value]); return chain; },
      order: () => chain, maybeSingle: result, limit: (limit: number) => { query.limit = limit; return result(); },
    };
    return chain;
  } };
} }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: h.configured, resolveProvider: h.provider, describeAIError: () => ({ message: 'Provider failed' }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, meta: unknown, callback: (obs: unknown) => unknown) => {
  h.ledger(meta); return callback({ used: vi.fn(), failed: vi.fn() });
} }));

function t(key: string) { return translate(getMessages(h.locale), key); }
function escaped(text: string) { return renderToStaticMarkup(createElement('span', null, text)).slice(6, -7); }
function withLocale(children: ReactNode) {
  const props = { locale: localeOrDefault(h.locale), source: 'cookie', messages: getMessages(h.locale), children } as const;
  return createElement(LocaleProvider, props);
}
async function pageHtml() {
  let result: ReactNode = await ContactTimelinePage({ params: Promise.resolve({ id: 'contact-1' }) });
  // Resolve the page's async failure shell; client components remain real.
  if (isValidElement(result) && typeof result.type === 'function' && result.type.name === 'ReadFailure') {
    result = await (result.type as (props: unknown) => Promise<ReactNode>)(result.props);
  }
  return renderToStaticMarkup(withLocale(result));
}
function expectNoDraftWork() {
  expect(h.provider).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled(); expect(h.ledger).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.locale = 'en-US'; h.failureTable = ''; h.mode = ''; h.empty = false; h.missingContact = false; h.queries = [];
  vi.clearAllMocks(); h.configured.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.provider.mockResolvedValue({ model: 'test', complete: h.complete });
  h.complete.mockResolvedValue({ text: 'Grounded draft', usage: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

describe.each(['family_contacts', 'contact_interactions', 'family_communications'])('%s required read', (table) => {
  const modes = table === 'family_contacts' ? ['error', 'reject', 'throw', 'null-reject'] : ['error', 'reject', 'throw', 'null-reject', 'missing'];
  it.each(modes)('shows retry instead of empty/partial history on %s', async (mode) => {
    h.failureTable = table; h.mode = mode;
    const html = await pageHtml();
    expect(html).toContain(escaped(t('contactTimeline.historyUnavailable')));
    expect(html).toContain(escaped(t('states.tryAgain')));
    expect(html).not.toContain(escaped(t('contactTimeline.nothingHereYetLogYourFirst')));
    expect(html).not.toContain('Saved call'); expect(html).not.toContain('Partial history'); expect(html).not.toContain('Partial record');
    expectNoDraftWork();
  });
  it.each(modes)('never creates an AI request or calls the provider on %s', async (mode) => {
    h.failureTable = table; h.mode = mode;
    expect(await draftReconnectMessageAction('contact-1')).toEqual({ ok: false, error: t('contactTimeline.historyUnavailable') });
    expectNoDraftWork();
    expect(console.error).toHaveBeenCalledWith('[contacts-reconnect] required read failed', {
      source: table === 'family_contacts' ? 'contact' : table === 'contact_interactions' ? 'interactions' : 'communications',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/Partial|Returned error|Saved/);
  });
});

it('renders and drafts successfully from complete family/contact-scoped history with the original recent limits', async () => {
  const html = await pageHtml();
  expect(html).toContain('Saved call'); expect(html).toContain('Saved email');
  expect(html).not.toContain(escaped(t('contactTimeline.historyUnavailable')));
  expect(await draftReconnectMessageAction('contact-1', 'brief')).toEqual({ ok: true, message: 'Grounded draft', tone: 'brief' });
  expect(h.complete.mock.calls[0][0].messages[0].content).toContain('Saved call (Saved detail)');
  expect(h.complete.mock.calls[0][0].messages[0].content).toContain('Saved email (Saved summary)');
  expect(h.queries.filter((q) => q.table === 'contact_interactions').map((q) => q.limit)).toEqual([500, 12]);
  expect(h.queries.filter((q) => q.table === 'family_communications').map((q) => q.limit)).toEqual([200, 8]);
  for (const query of h.queries) {
    expect(query.filters).toContainEqual(['family_id', 'family-1']);
    expect(query.filters).toContainEqual([query.table === 'family_contacts' ? 'id' : 'contact_id', 'contact-1']);
  }
});

it('allows genuinely empty successful history and distinguishes a missing contact', async () => {
  h.empty = true;
  expect(await pageHtml()).toContain(escaped(t('contactTimeline.nothingHereYetLogYourFirst')));
  expect(await draftReconnectMessageAction('contact-1')).toMatchObject({ ok: true });
  expect(h.complete.mock.calls[0][0].messages[0].content).toContain('no logged history');
  h.missingContact = true; h.complete.mockClear(); h.provider.mockClear(); h.ledger.mockClear();
  await expect(pageHtml()).rejects.toThrow('NOT_FOUND');
  expect(await draftReconnectMessageAction('contact-1')).toEqual({ ok: false, error: t('actions.contactNotFound') });
  expectNoDraftWork();
});

it('handles client construction failure and preserves the authentication redirect boundary', async () => {
  h.failureTable = 'client';
  expect(await pageHtml()).toContain(escaped(t('contactTimeline.historyUnavailable')));
  expect(await draftReconnectMessageAction('contact-1')).toEqual({ ok: false, error: t('contactTimeline.historyUnavailable') });
  h.failureTable = 'auth';
  await expect(pageHtml()).rejects.toThrow('AUTH_REDIRECT');
  await expect(draftReconnectMessageAction('contact-1')).rejects.toThrow('AUTH_REDIRECT');
  expect(h.queries).toEqual([]); expectNoDraftWork();
});

it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as LocaleCode[])('offers a real route refresh and a localized error in %s', async (locale) => {
  h.locale = locale; h.failureTable = 'contact_interactions'; h.mode = 'error';
  expect(await pageHtml()).toContain(escaped(t('contactTimeline.historyUnavailable')));
  expect(await draftReconnectMessageAction('contact-1')).toEqual({ ok: false, error: t('contactTimeline.historyUnavailable') });
  let boundary: ReactElement<{ onRetry: () => void }> | undefined;
  function Capture() { boundary = ContactTimelineReadError(); return boundary; }
  const html = renderToStaticMarkup(withLocale(createElement(Capture)));
  expect(html).toContain(escaped(t('states.tryAgain')));
  boundary!.props.onRetry(); expect(h.refresh).toHaveBeenCalledOnce();
});
