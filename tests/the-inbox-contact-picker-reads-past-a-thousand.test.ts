import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N14-S1 — the Communications Hub, the REAL module and its own reads, against
// an in-memory database whose responses stop at 1,000 rows like PostgREST's
// db-max-rows.
//
// The inbox read the family's contacts in one unpaged select. Past 1,000 the
// server answered a prefix with no error: the sidebar said "1000 total", and
// the Log message and AI Import pickers did not list any contact after the
// 1,000th, so a message could not be linked to them. One phone or vCard import
// brings in that many (N14, the Contacts page).

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
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn() }));

const { InboxModule } = await import('@/components/modules/inbox-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

async function show(): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(InboxModule));
  for (let i = 0; i < 8; i++) { await settle(); tree = render(h.hooks, createElement(InboxModule)); }
  return tree;
}
const screen = () => render(h.hooks, createElement(InboxModule));
/** The option values of the open dialog's contact picker. */
const pickerIds = (dialog: Node) => {
  const select = nodes(dialog.props.children as ReactNode)
    .find((n) => n.type === 'select' && nodes(n.props.children as ReactNode).some((o) => o.props.value === ''))!;
  return nodes(select.props.children as ReactNode).filter((o) => o.type === 'option').map((o) => o.props.value);
};
const dialog = (tree: ReactNode, title: string) => nodes(tree).find((n) => n.props.role === 'dialog' && n.props['aria-label'] === title)!;

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
      category: 'friend', is_emergency: false, phone: null, email: null, photo_url: null,
    })),
    { id: 'c-zelda', family_id: FAMILY, name: 'Zelda Zwick', category: 'doctor', is_emergency: false, phone: '555-0100', email: null, photo_url: null },
  ]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the inbox reads the whole contact book', () => {
  it('counts every contact in the sidebar', async () => {
    const tree = await show();
    expect(has(tree, '1501 total')).toBe(true);
    expect(has(tree, '1000 total')).toBe(false);
  });

  it('the Log message picker lists a contact past the thousandth, and a message is linked to them', async () => {
    await show();
    await click(byName(screen(), t('inbox.logMessage'), 'button'));
    const sheet = dialog(screen(), t('inbox.logCommunication'));
    const ids = pickerIds(sheet);
    expect(ids).toContain('c-zelda');
    expect(ids).toHaveLength(1502);

    await submit(form(screen()), { contact_id: 'c-zelda', subject: 'Results are in', channel: 'call', direction: 'inbound', category: 'medical', priority: 'normal', received_at: '' });
    expect(h.toasts.error).toEqual([]);
    expect(db.table('family_communications').map((row) => row.contact_id)).toEqual(['c-zelda']);
  });

  it('the AI Import picker lists a contact past the thousandth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [{ name: 'appointment', summary: 'Follow-up on Friday' }] }) })));
    await show();
    await click(byName(screen(), t('inbox.aiImport'), 'button'));
    const box = nodes(dialog(screen(), t('inbox.aiImport')).props.children as ReactNode).find((n) => n.type === 'textarea')!;
    change(box, 'Dr Zwick: follow-up on Friday');
    await click(byName(screen(), t('inbox.parseWithAi'), 'button'));
    expect(pickerIds(dialog(screen(), t('inbox.aiImport')))).toContain('c-zelda');
  });
});
