import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { change, has, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N14 — the Contacts page, the REAL module and its own read, against an
// in-memory database whose responses are capped at 1,000 rows like PostgREST's
// db-max-rows.
//
// One unbounded select read the family's contacts. A single phone or vCard
// import brings in up to 2,000, and past 1,000 the server answered a prefix
// with no error: the contacts later in the alphabet were missing from the
// list, the tab read "All (1000)", and a search for one the family has said
// "No contacts found".

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { ContactsModule } = await import('@/components/modules/contacts-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

async function show(): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(ContactsModule));
  for (let i = 0; i < 8; i++) { await settle(); tree = render(h.hooks, createElement(ContactsModule)); }
  return tree;
}
const searchBox = (tree: ReactNode) => nodes(tree).find((n) => n.type === 'input' && n.props.placeholder === t('contacts.searchContacts')) as Node;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.realtime = {};
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // One phone import's worth, plus one contact late in the alphabet.
  db.seed('family_contacts', [
    ...Array.from({ length: 1500 }, (_, i) => ({
      id: `c-${String(i).padStart(4, '0')}`, family_id: FAMILY, name: `Contact ${String(i).padStart(4, '0')}`,
      category: 'friend', is_emergency: false, phone: null, email: null, relationship: null, organization: null,
    })),
    { id: 'c-zelda', family_id: FAMILY, name: 'Zelda Zwick', category: 'doctor', is_emergency: false, phone: '555-0100', email: null, relationship: null, organization: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('the contact book is read whole', () => {
  it('counts every contact on the All tab', async () => {
    const tree = await show();
    expect(has(tree, `${t('contacts.all')}1501)`)).toBe(true);
    expect(has(tree, `${t('contacts.all')}1000)`)).toBe(false);
  });

  it('lists a contact past the thousandth, and a search finds it', async () => {
    let tree: ReactNode = await show();
    expect(has(tree, 'Zelda Zwick')).toBe(true);
    change(searchBox(tree), 'Zelda');
    tree = render(h.hooks, createElement(ContactsModule));
    expect(has(tree, 'Zelda Zwick')).toBe(true);
    expect(has(tree, t('contacts.noContactsFound'))).toBe(false);
  });
});
