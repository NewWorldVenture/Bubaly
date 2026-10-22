// N9 — saving a note silently overwrote a partner's edit made while the editor
// was open.
//
// The note's content write was conditional on title and body, but on the
// values updateNote had JUST read on the server, not on what the editor had
// opened with. So: A opens the note, B saves, A saves — the server reads B's
// text, the condition matches it, A's text replaces it, and A sees "Note
// saved". The condition only covered the milliseconds between the server's
// own read and its write.
//
// Driven end to end: the REAL notes module (tests/helpers/module-harness.tsx),
// the REAL saveNoteAction and the REAL notes service, against an in-memory
// database. Only the session and the request are stubbed.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, nodes, render, submit, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
// The server half: the real action, with the session and request stubbed.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string) => tr(messages, key) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-a', email: null },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-a' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));

const { NotesModule } = await import('@/components/modules/notes-module');
const { saveNoteAction } = await import('@/app/(app)/dashboard/notes/actions');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;
const note = () => db.table('notes').find((n) => n.id === 'note-1')!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  db.seed('notes', [{ id: 'note-1', family_id: FAMILY, title: 'Groceries', body: 'milk', is_pinned: false, created_by: 'user-a', updated_at: '2026-10-13T08:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(NotesModule));

/** Open the note and press Edit, as A does: the editor now holds what it opened with. */
async function openEditor(): Promise<ReactNode> {
  const card = nodes(screen()).find((n) => typeof n.props.onClick === 'function' && n.type === 'button' && text(n).startsWith('Groceries'));
  expect(card, 'the note is listed').toBeDefined();
  await click(card as Node);
  await click(byName(screen(), t('notes.edit'), 'button'));
  return screen();
}
const contentField = (tree: ReactNode) => nodes(form(tree)).find((n) => n.type === 'textarea') as Node;

describe('a note is not saved over a partner\'s edit', () => {
  it('A\'s save is refused when B saved after A opened the editor, and B\'s words stay', async () => {
    const editor = await openEditor();
    // B, on another phone, saves while A's editor is open.
    expect(await saveNoteAction('note-1', { title: 'Groceries', body: 'milk, eggs' })).toMatchObject({ ok: true });
    expect(note().body).toBe('milk, eggs');

    change(contentField(editor), 'milk, bread');
    await submit(form(screen()));

    expect(note().body).toBe('milk, eggs');
    expect(h.toasts.error).toContain(t('actions.thisNoteChangedSinceYouOpenedIt'));
    expect(h.toasts.success).not.toContain(t('notesModule.noteSaved'));
    // The editor is still open with A's text, so nothing A typed is lost.
    expect(contentField(screen()).props.value).toBe('milk, bread');
  });

  it('with no other save in between, A\'s edit is saved', async () => {
    const editor = await openEditor();
    change(contentField(editor), 'milk, bread');
    await submit(form(screen()));

    expect(note().body).toBe('milk, bread');
    expect(h.toasts.success).toContain(t('notesModule.noteSaved'));
  });
});
