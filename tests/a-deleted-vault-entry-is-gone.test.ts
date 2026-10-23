// A deleted vault entry is gone, not stamped.
//
// Wi-Fi & Passwords › Delete entry ("This removes it for the whole family")
// stamped `deleted_at` and toasted "Entry deleted". family_credentials stores
// the secret in plain text (0119); nothing in app/, lib/ or any cron ever
// hard-deleted or purged a stamped row; and the SELECT policy (0296, 0391's
// step-up guard) carries no `deleted_at is null` clause — so
// `GET /rest/v1/family_credentials` from any manager's cleared session returned
// every secret the family believed it had deleted, indefinitely. The module's
// delete is now a real DELETE, read back for the rows: the delete policies
// admit exactly the actor the soft-delete UPDATE did, so nothing widens, and a
// refused one is still "not saved" rather than a toast over a secret still in
// the vault.
//
// Drives the REAL module through tests/helpers/module-harness.tsx against the
// in-memory database.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);

const { PasswordsModule } = await import('@/components/modules/passwords-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

const WIFI = {
  id: 'cred-wifi', label: 'Home Wi-Fi', category: 'wifi', username: 'Rivera-5G', secret: 'correct horse battery staple',
  url: null, notes: null, member_id: null, is_favorite: false, deleted_at: null, created_at: '2026-09-01T10:00:00Z',
};

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  db.seed('family_credentials', [
    { ...WIFI, family_id: h.app.familyId },
    { ...WIFI, id: 'cred-bank', label: 'Bank', category: 'website', secret: 'another one', family_id: h.app.familyId },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The open menu listens for Escape on the window.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(PasswordsModule));

/** Open the entry's menu, choose Delete, confirm — the family's three clicks. */
async function deleteEntry(label: string) {
  await click(byName(screen(), t('passwordsModule.actionsFor', { name: label })));
  await click(byName(screen(), t('passwords.delete')));
  await click(byName(screen(), t('passwords.delete')));
}

const writes = () => h.calls.filter((c) => c.table === 'family_credentials' && c.calls.some((m) => m === 'delete' || m === 'update'));

describe('deleting a vault entry', () => {
  it('removes the row — the plaintext secret leaves the table — and says so', async () => {
    await deleteEntry('Home Wi-Fi');

    expect(db.table('family_credentials').map((row) => row.id)).toEqual(['cred-bank']);
    expect(db.table('family_credentials').some((row) => row.secret === WIFI.secret)).toBe(false);
    expect(h.toasts.success).toContain(t('passwordsModule.entryDeleted'));
    expect(h.toasts.error).toEqual([]);
    // One DELETE, read back for its rows; never an UPDATE that stamps a row.
    const [write, ...more] = writes();
    expect(more).toEqual([]);
    expect(write.calls).toContain('delete');
    expect(write.calls).toContain('select');
    expect(write.calls).not.toContain('update');
  });

  it('a delete the database refused leaves the entry in the vault and is told as not saved', async () => {
    h.fault = (table, calls) => (table === 'family_credentials' && calls.includes('delete') ? { message: 'permission denied', code: '42501' } : null);
    await deleteEntry('Home Wi-Fi');

    expect(db.table('family_credentials').map((row) => row.id)).toEqual(['cred-wifi', 'cred-bank']);
    expect(h.toasts.success).not.toContain(t('passwordsModule.entryDeleted'));
    expect(h.toasts.error).toHaveLength(1);
  });

  it('a delete that matched no row (RLS filtered it, or it was already gone) is not reported as done', async () => {
    const before = screen();
    await click(byName(before, t('passwordsModule.actionsFor', { name: 'Home Wi-Fi' })));
    await click(byName(screen(), t('passwords.delete')));
    // Another manager deleted it meanwhile.
    db.replace('family_credentials', db.table('family_credentials').filter((row) => row.id !== 'cred-wifi'));
    await click(byName(screen(), t('passwords.delete')));

    expect(h.toasts.success).not.toContain(t('passwordsModule.entryDeleted'));
    expect(h.toasts.error).toEqual([t('errors.thatChangeWasNotSaved')]);
  });

  it('the screen the family sees next no longer lists the entry', async () => {
    await deleteEntry('Home Wi-Fi');
    const after = screen();
    const { has } = await import('./helpers/module-harness');
    expect(has(after, 'Home Wi-Fi')).toBe(false);
    expect(has(after, 'Bank')).toBe(true);
  });
});
