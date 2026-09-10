import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactsModule } from '@/components/modules/contacts-module';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import type { Tables } from '@/lib/database.types';
import { generateMetadata } from '@/app/(app)/dashboard/contacts/page';

type Contact = Tables<'family_contacts'>;
type NodeProps = Record<string, unknown> & { children?: ReactNode; action?: ReactNode };
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, contacts: [] as Contact[], locale: 'en-US' as LocaleCode, deleting: false,
  tree: null as ReactNode, form: null as ReactElement<NodeProps> | null,
  success: vi.fn(), error: vi.fn(), refresh: vi.fn(), insert: vi.fn(), update: vi.fn(), eq: vi.fn(),
}));

// Keep the real component, provider, fields and server rendering. Simulated
// state lets us drive its event handlers in the repository's Node test runner;
// the modal shim only removes the browser portal/focus lifecycle.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => {
      harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next;
    }];
  },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1' }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: harness.contacts, loading: false, error: null, refresh: harness.refresh }),
}));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ run: vi.fn(), isPending: () => harness.deleting }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: harness.success, error: harness.error }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: () => ({ insert: harness.insert, update: harness.update }),
}) }));
vi.mock('@/components/ui/modal', async () => {
  const { createElement: element } = await import('react');
  return { Modal: ({ title, children }: { title: string; children: ReactElement<NodeProps> }) => {
    harness.form = children;
    return element('section', { role: 'dialog', 'aria-label': title }, element('h2', null, title), children);
  } };
});
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => tr(messages(harness.locale), key) };
});

const LOCALES: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const CATEGORIES = [
  ['emergency', 'contacts.emergency'], ['family', 'family.family'],
  ['doctor', 'contactsModule.categoryDoctor'], ['dentist', 'contactsModule.categoryDentist'],
  ['teacher', 'school.teacher'], ['coach', 'sports.coach'],
  ['babysitter', 'contactsModule.categoryBabysitter'], ['neighbor', 'contactsModule.categoryNeighbor'],
  ['work', 'contactsModule.categoryWork'], ['friend', 'contactsModule.categoryFriend'],
  ['other', 'conciergeCalls.categoryOther'],
] as const;
const MAY: Record<string, string> = {
  'en-US': 'May', 'de-DE': 'Mai', 'es-ES': 'mayo', 'fr-FR': 'mai',
  'it-IT': 'maggio', 'nl-NL': 'mei', 'pt-PT': 'maio',
};

function t(key: string, params?: Record<string, string | number>) {
  return translate(getMessages(harness.locale), key, params);
}
function escaped(value: string) { return renderToStaticMarkup(createElement('span', null, value)).slice(6, -7); }
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<NodeProps>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function nodes(node: ReactNode): ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<NodeProps>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.action)];
}
function find(predicate: (node: ReactElement<NodeProps>) => boolean) {
  const node = nodes(harness.tree).find(predicate);
  expect(node, 'rendered control exists').toBeDefined();
  return node!;
}
function clickText(label: string) {
  const node = find((n) => typeof n.props.onClick === 'function' && textOf(n.props.children).trim() === label);
  (node.props.onClick as () => void)();
}
function Capture() { harness.tree = ContactsModule(); return harness.tree; }
function render() {
  harness.cursor = 0;
  harness.form = null;
  const providerProps = {
    locale: localeOrDefault(harness.locale), source: 'cookie', messages: getMessages(harness.locale),
    children: createElement(Capture),
  } as const;
  return renderToStaticMarkup(createElement(LocaleProvider, providerProps));
}
function contact(category: string, overrides: Partial<Contact> = {}): Contact {
  return {
    id: `contact-${category}`, family_id: 'family-1', created_by: 'user-1',
    name: `Person ${category}`, category, relationship: null, phone: '+15551234567',
    phone_alt: '+15559876543', email: 'person@example.com', address: '123 Example Street',
    specialty: null, organization: null, notes: null, is_emergency: false,
    birthday_month: 5, birthday_day: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
    ...overrides,
  } as Contact;
}
function selectContact(name: string) {
  const row = find((n) => n.type === 'div' && typeof n.props.onClick === 'function' && textOf(n.props.children).includes(name));
  (row.props.onClick as () => void)();
}
async function submit(values: Record<string, string>) {
  expect(harness.form).not.toBeNull();
  const handler = harness.form!.props.onSubmit as (event: unknown) => Promise<void>;
  await handler({ preventDefault: vi.fn(), currentTarget: values });
}

beforeEach(() => {
  harness.slots = [];
  harness.contacts = [];
  harness.locale = 'en-US';
  harness.deleting = false;
  for (const mock of [harness.success, harness.error, harness.refresh, harness.insert, harness.update, harness.eq]) mock.mockReset();
  harness.insert.mockResolvedValue({ error: null });
  harness.eq.mockResolvedValue({ error: null });
  harness.update.mockReturnValue({ eq: harness.eq });
  vi.stubGlobal('FormData', class {
    constructor(private values: Record<string, string>) {}
    get(key: string) { return this.values[key] ?? null; }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(LOCALES)('family contacts in %s', (locale) => {
  beforeEach(() => { harness.locale = locale; });

  it('renders translated categories, accessible actions and the selected birthday', () => {
    harness.contacts = CATEGORIES.map(([category]) => contact(category));
    let html = render();
    for (const [, key] of CATEGORIES) {
      expect(getRawMessages(locale)[key]).toBeTruthy();
      expect(html).toContain(escaped(t(key)));
    }
    expect(html).toContain(`aria-label="${escaped(t('contactsModule.callContact', { name: 'Person doctor' }))}"`);
    expect(html).toContain(`aria-label="${escaped(t('contactsModule.emailContact', { name: 'Person doctor' }))}"`);
    const namedActions = [...html.matchAll(/aria-label="([^"]*)"/g)].filter((match) => match[1].includes('Person doctor'));
    expect(namedActions).toHaveLength(2);
    selectContact('Person doctor');
    html = render();
    expect(html).toContain(escaped(t('family.birthday')));
    expect(html).toContain(MAY[locale]);
    expect(html).toContain(escaped(t('contactsModule.alternatePhoneSuffix')));
    for (const key of ['contacts.edit', 'home.close', 'family.copy', 'findPhoneView.openInMaps']) {
      expect(html).toContain(`aria-label="${escaped(t(key))}"`);
    }
    expect(html).toContain(escaped(t('crm.delete')));
    harness.deleting = true;
    html = render();
    expect(html).toContain(escaped(t('vacationDisruption.working')));
    const pending = find((node) => node.props.disabled === true && textOf(node.props.children).includes(t('vacationDisruption.working')));
    expect(pending.props.disabled).toBe(true);
    expect(html).not.toMatch(/contactsModule\./);
  });

  it('opens the real form with translated months and stable category/month values, then saves both modes', async () => {
    render();
    clickText(t('contacts.addContact'));
    let html = render();
    expect(html).toContain(escaped(t('contactsModule.newContact')));
    expect(html).toContain(`placeholder="${escaped(t('contactsModule.day'))}"`);
    for (const [category] of CATEGORIES) expect(html).toContain(`value="${category}"`);
    const options = [...html.matchAll(/<option value="(\d+)"[^>]*>([^<]+)<\/option>/g)];
    expect(options.map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(options[4][2]).toBe(MAY[locale]);
    await submit({ name: 'Test person', category: 'doctor', birthday_month: options[4][1], birthday_day: '1' });
    expect(harness.insert).toHaveBeenCalledWith(expect.objectContaining({
      family_id: 'family-1', created_by: 'user-1', category: 'doctor', birthday_month: 5, birthday_day: 1,
    }));
    expect(harness.success).toHaveBeenLastCalledWith(t('contactsModule.contactAdded'));

    harness.contacts = [contact('doctor')];
    render();
    selectContact('Person doctor');
    render();
    clickText(t('contacts.edit'));
    html = render();
    expect(html).toContain(escaped(t('contactsModule.editContact')));
    expect(html).toContain(escaped(t('family.saveChanges')));
    expect(html).toMatch(/name="category"[^>]*checked=""[^>]*value="doctor"|name="category"[^>]*value="doctor"[^>]*checked=""/);
    await submit({ name: 'Edited person', category: 'doctor', birthday_month: '5', birthday_day: '1' });
    expect(harness.update).toHaveBeenCalledWith(expect.objectContaining({ category: 'doctor', birthday_month: 5, birthday_day: 1 }));
    expect(harness.eq).toHaveBeenCalledWith('id', 'contact-doctor');
    expect(harness.success).toHaveBeenLastCalledWith(t('contactsModule.contactUpdated'));
  });

  it('translates both empty-state branches and validation failures without saving', async () => {
    expect(render()).toContain(escaped(t('contactsModule.emptyContacts')));
    const search = find((n) => n.type === 'input' && n.props.placeholder === t('contacts.searchContacts'));
    (search.props.onChange as (event: unknown) => void)({ target: { value: 'missing' } });
    const html = render();
    expect(html).toContain(escaped(t('contactsModule.emptySearch')));
    expect(html).toContain(`aria-label="${escaped(t('reminders.clearSearch'))}"`);
    clickText(t('contacts.addContact'));
    render();
    await submit({ name: 'x'.repeat(121) });
    expect(harness.error).toHaveBeenLastCalledWith(t('contactsModule.nameTooLong', { max: 120 }));
    await submit({ name: 'Test person', email: 'broken' });
    expect(harness.error).toHaveBeenLastCalledWith(t('contactsModule.emailInvalid'));
    expect(harness.insert).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.success).not.toHaveBeenCalled();
  });

  it('resolves the route title using the request locale', async () => {
    expect(await generateMetadata()).toEqual({ title: t('contacts.familyContacts') });
  });
});

it('reformats an open form on locale changes without translating persisted values', () => {
  render();
  clickText(t('contacts.addContact'));
  expect(render()).toContain('>May</option>');
  harness.locale = 'fr-FR';
  const html = render();
  expect(html).toContain('>mai</option>');
  expect(html).not.toContain('>May</option>');
  expect(html).toContain('value="doctor"');
  expect(html).toContain('value="5"');
  expect(html).toContain('Nouveau contact');
});

it('keeps a leap-day birthday as a calendar date with an explicit UTC formatting zone', () => {
  harness.locale = 'fr-FR';
  harness.contacts = [contact('doctor', { birthday_month: 2, birthday_day: 29 })];
  const format = Date.prototype.toLocaleDateString;
  const seen: { instant: number; locale: unknown; options: unknown }[] = [];
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, locale, options) {
    seen.push({ instant: this.getTime(), locale, options });
    return format.call(this, locale, options);
  });
  render();
  selectContact('Person doctor');
  expect(render()).toContain('29 février');
  expect(seen).toEqual([{ instant: Date.UTC(2000, 1, 29), locale: 'fr-FR', options: {
    month: 'long', day: 'numeric', timeZone: 'UTC',
  } }]);
});
