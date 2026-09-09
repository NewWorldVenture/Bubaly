import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactTimelineModule } from '@/components/modules/contact-timeline-module';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { buildContactTimeline, contactHealth, type TimelineEntry } from '@/lib/contacts/timeline';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import type { Tables } from '@/lib/database.types';

type Props = Record<string, unknown> & { children?: ReactNode };
const h = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, slots: [] as unknown[], cursor: 0,
  tree: null as ReactNode, pending: false, work: [] as Promise<unknown>[],
  log: vi.fn(), remove: vi.fn(), draft: vi.fn(), complete: vi.fn(), ledger: vi.fn(),
}));

// Render the actual component and locale provider. Simulated hook state lets
// the Node runner drive real handlers, without claiming browser lifecycle tests.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
  },
  useTransition: () => [h.pending, (callback: () => unknown) => { h.work.push(Promise.resolve(callback())); }],
}));
vi.mock('@/app/(app)/dashboard/contacts/[id]/actions', () => ({
  logInteractionAction: h.log, deleteInteractionAction: h.remove, draftReconnectMessageAction: h.draft,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  const { localeOrDefault: locale } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages(h.locale), key, params),
    getLocaleContext: async () => ({ locale: locale(h.locale), messages: messages(h.locale), source: 'cookie' }),
  };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1' } }) }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({ familyId: 'family-1', userId: 'user-1' }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({ from: (table: string) => {
  const chain = {
    select: () => chain, eq: () => chain, order: () => chain,
    maybeSingle: async () => ({ data: { name: 'Alex', relationship: 'Friend', birthday_month: null, birthday_day: null }, error: null }),
    limit: async () => ({ data: table === 'contact_interactions' ? [{ id: 'one', kind: 'call', occurred_on: '2026-06-01', title: 'Saved title', note: 'Saved detail', amount: null }] : [], error: null }),
  };
  return chain;
} }) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true, resolveProvider: async () => ({ model: 'test', complete: h.complete }),
  describeAIError: () => ({ message: 'Provider failure' }),
}));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, metadata: unknown, callback: (obs: unknown) => unknown) => {
  h.ledger(metadata);
  return callback({ used: vi.fn(), failed: vi.fn() });
} }));

const LOCALES: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const NOW = new Date('2026-06-15T00:00:00Z');
const contact = {
  id: 'contact-1', name: 'Alex', family_id: 'family-1', relationship: null,
  organization: null, specialty: null, birthday_month: 2, birthday_day: 29,
} as Tables<'family_contacts'>;
function t(key: string, params?: Record<string, string | number>) { return translate(getMessages(h.locale), key, params); }
function escaped(text: string) { return renderToStaticMarkup(createElement('span', null, text)).slice(6, -7); }
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<Props>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function find(predicate: (node: ReactElement<Props>) => boolean) {
  const node = nodes(h.tree).find(predicate);
  expect(node, 'real rendered control exists').toBeDefined();
  return node!;
}
function click(label: string) {
  const control = find((node) => node.type === 'button' && textOf(node.props.children).trim() === label);
  (control.props.onClick as () => void)();
}
function expandDrafter(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expandDrafter);
  if (!isValidElement<Props>(node)) return node;
  if (typeof node.type === 'function' && node.type.name === 'ReconnectDrafter') return (node.type as (props: Props) => ReactNode)(node.props);
  return node.props.children === undefined ? node : cloneElement(node, undefined, expandDrafter(node.props.children));
}
function render(timeline: TimelineEntry[] = [], now = NOW) {
  h.cursor = 0;
  function Capture() {
    h.tree = expandDrafter(ContactTimelineModule({ contact, timeline, health: contactHealth(timeline, contact.name, t, now), interactionIds: ['one'] }));
    return h.tree;
  }
  const props = { locale: localeOrDefault(h.locale), source: 'cookie', messages: getMessages(h.locale), children: createElement(Capture) } as const;
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}
function entry(date = '2026-06-15'): TimelineEntry {
  return { id: 'int-one', kind: 'gift', date, title: 'Saved title', detail: 'Saved detail', amount: 1234.5 };
}

beforeEach(() => {
  h.locale = 'en-US'; h.slots = []; h.cursor = 0; h.tree = null; h.pending = false; h.work = [];
  vi.clearAllMocks();
  h.log.mockResolvedValue(undefined); h.remove.mockResolvedValue(undefined);
  h.draft.mockResolvedValue({ ok: true, message: 'Original provider message', tone: 'warm' });
  h.complete.mockResolvedValue({ text: 'Original provider message', usage: {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each(LOCALES)('Contact timeline in %s', (locale) => {
  beforeEach(() => { h.locale = locale; });

  it('renders translated chrome and generated entries while retaining user text, IDs and ordering', () => {
    const timeline = buildContactTimeline({ t, now: NOW, birthdayMonth: 3, birthdayDay: 14,
      interactions: [{ id: 'one', kind: 'gift', occurred_on: '2026-06-15', title: 'Saved title', note: 'Saved detail', amount: 1234.5 }],
      communications: [
        { id: 'a', channel: 'call', direction: 'inbound', subject: null, summary: null, received_at: '2026-06-14T23:00:00Z' },
        { id: 'b', channel: 'email', direction: 'outbound', subject: null, summary: 'Original summary', received_at: '2026-06-13T02:00:00Z' },
        { id: 'c', channel: 'custom-channel', direction: 'outbound', subject: 'Original subject', summary: null, received_at: '2026-06-12T02:00:00Z' },
      ],
    });
    expect(timeline.map((e) => e.id)).toEqual(['int-one', 'comm-a', 'comm-b', 'comm-c', 'bday-2026']);
    expect(timeline[1].title).toBe(t('contactTimeline.heardFrom', { channel: t('contacts.call') }));
    expect(timeline[2].title).toBe(t('contactTimeline.reachedOut', { channel: t('contacts.email') }));
    expect(timeline[3].title).toBe('Original subject');
    const html = render(timeline);
    for (const expected of [t('contactTimeline.familyContact'), t('contactTimeline.logTouch'), t('contactTimeline.statusFresh'), t('contactTimeline.suggestionFreshToday', { name: 'Alex' }), `${t('family.birthday')} 🎂`, 'Saved title', 'Saved detail', 'Original subject', 'Original summary']) expect(html).toContain(escaped(expected));
    expect(html).toContain(escaped(new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(1234.5)));
    expect(html).toContain(escaped(new Date('2026-06-15T00:00:00Z').toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })));
    expect(html).toContain(escaped(new Date('2000-02-29T00:00:00Z').toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })));
    expect(html).toContain(escaped(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day')));
    expect(nodes(h.tree).filter((n) => n.props['aria-label'] === t('contactTimeline.deleteEntry'))).toHaveLength(1);
    const sourceKeys = Object.keys(getRawMessages('en-US')).filter((key) => key.startsWith('contactTimeline.'));
    for (const key of sourceKeys) expect(getRawMessages(locale)[key], key).toBeTruthy();
    expect(html).not.toMatch(/contactTimeline\.[a-zA-Z]/);
  });

  it('renders every relationship status and interpolated nudge from the selected catalogue', () => {
    for (const [date, statusKey, suggestionKey, days] of [
      [null, 'statusNoHistory', 'suggestionNoHistory', null],
      ['2026-06-14', 'statusFresh', 'suggestionFreshDays', 1],
      ['2026-05-10', 'statusDue', 'suggestionDue', 36],
      ['2026-01-01', 'overdue', 'suggestionOverdue', 165],
    ] as const) {
      const html = render(date ? [entry(date)] : []);
      expect(html).toContain(escaped(t(statusKey === 'overdue' ? 'reminders.overdue' : `contactTimeline.${statusKey}`)));
      expect(html).toContain(escaped(t(`contactTimeline.${suggestionKey}`, days === null ? { name: 'Alex' } : { name: 'Alex', days })));
    }
    const html = render([entry('2026-06-14'), { ...entry('2026-06-07'), id: 'two' }, { ...entry('2026-05-31'), id: 'three' }]);
    expect(html).toContain(escaped(t('contactTimeline.usualRhythm', { days: 7 })));
  });

  it('opens the translated composer and submits the original kind, date, amount and deletion identity', async () => {
    render([entry()]); click(t('contactTimeline.logTouch'));
    const html = render([entry()]);
    expect(html).toContain(escaped(t('home.close')));
    const radios = nodes(h.tree).filter((n) => n.type === 'input' && n.props.type === 'radio');
    expect(radios.map((n) => n.props.value)).toEqual(['visit', 'call', 'message', 'gift', 'favor', 'note']);
    for (const key of ['contactTimeline.visit', 'contacts.call', 'contact.message', 'relationship.gift', 'contactTimeline.favor', 'search.kindNote']) expect(html).toContain(escaped(t(key)));
    const form = find((n) => n.type === 'form');
    const data = new FormData();
    for (const [key, value] of Object.entries({ contact_id: 'contact-1', kind: 'favor', occurred_on: '2026-02-28', amount: '12.34', title: 'Do not translate', note: 'Saved note' })) data.set(key, value);
    (form.props.action as (fd: FormData) => void)(data);
    await Promise.all(h.work);
    expect(h.log).toHaveBeenCalledWith(data);
    expect(Object.fromEntries(data.entries())).toMatchObject({ kind: 'favor', occurred_on: '2026-02-28', amount: '12.34', title: 'Do not translate' });
    render([entry()]);
    expect(nodes(h.tree).some((n) => n.type === 'form')).toBe(false);
    const button = find((n) => n.props['aria-label'] === t('contactTimeline.deleteEntry'));
    (button.props.onClick as () => void)(); await Promise.all(h.work);
    expect(h.remove).toHaveBeenCalledWith({ id: 'one', contactId: 'contact-1' });
  });

  it('renders translated tones, pending/copy states and keeps the selected machine tone and provider text', async () => {
    vi.useFakeTimers();
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    render(); click(t('contactTimeline.draftAMessageWithAi')); await Promise.all(h.work);
    let html = render();
    for (const key of ['toneWarm', 'toneBrief', 'tonePlayful']) expect(html).toContain(escaped(t(`contactTimeline.${key}`)));
    expect(html).toContain('Original provider message');
    click(t('contactTimeline.toneBrief')); await Promise.all(h.work); render();
    expect(h.draft).toHaveBeenLastCalledWith('contact-1', 'brief');
    click(t('family.copy')); await Promise.resolve();
    html = render(); expect(html).toContain(escaped(t('adminMarketingAssistant.copied')));
    expect(clipboard).toHaveBeenCalledWith('Original provider message');
    // Slots are the component's two states followed by the real drafter's five.
    h.slots[4] = null; h.pending = true;
    html = render(); expect(html).toContain(escaped(t('contactTimeline.writing')));
  });

  it('uses the selected output locale and a localized name-free request title in the real server action', async () => {
    const actions = await vi.importActual<typeof import('@/app/(app)/dashboard/contacts/[id]/actions')>('@/app/(app)/dashboard/contacts/[id]/actions');
    expect(await actions.draftReconnectMessageAction('contact-1', 'playful')).toEqual({ ok: true, message: 'Original provider message', tone: 'playful' });
    expect(h.ledger).toHaveBeenCalledWith({ feature: 'contacts.reconnect', text: t('contactTimeline.draftRequestTitle') });
    expect(h.ledger.mock.calls[0][0].text).not.toContain('Alex');
    const request = h.complete.mock.calls[0][0];
    expect(request.system).toContain(`selected locale: ${locale}.`);
    expect(request.messages[0].content).toContain('Desired tone: light and playful');
    expect(request.messages[0].content).toContain('Saved title (Saved detail)');
  });
  it('retries a failed history read with the selected tone and replaces the error after success', async () => {
    h.draft.mockResolvedValueOnce({ ok: false, error: t('contactTimeline.historyUnavailable') });
    render(); click(t('contactTimeline.draftAMessageWithAi')); await Promise.all(h.work);
    let html = render();
    expect(html).toContain(escaped(t('contactTimeline.historyUnavailable')));
    expect(html).toContain(escaped(t('states.tryAgain')));
    click(t('states.tryAgain')); await Promise.all(h.work);
    html = render();
    expect(h.draft).toHaveBeenLastCalledWith('contact-1', 'warm');
    expect(html).toContain('Original provider message');
    expect(html).not.toContain(escaped(t('contactTimeline.historyUnavailable')));
  });
});

it('uses UTC for calendar dates and leaves malformed saved dates and unknown channels readable', () => {
  const original = Date.prototype.toLocaleDateString;
  const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, locale, options) { return original.call(this, locale, options); });
  const html = render([entry('2026-02-30')]);
  expect(html).toContain('2026-02-30');
  for (const [, options] of spy.mock.calls) expect(options?.timeZone).toBe('UTC');
  const timeline = buildContactTimeline({ t, now: NOW, interactions: [], communications: [
    { id: 'x', channel: 'custom-channel', direction: 'outbound', subject: null, summary: null, received_at: NOW.toISOString() },
    { id: 'y', channel: 'toString', direction: 'inbound', subject: null, summary: null, received_at: NOW.toISOString() },
  ] });
  expect(timeline.map((e) => e.title)).toEqual(['Reached out · custom-channel', 'Heard from them · toString']);
});
