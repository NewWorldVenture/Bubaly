// household-roles N2-R1, the control's half. A family without Social now has
// one thing left in the console: each account it still has connected, with
// its Disconnect (app/(app)/dashboard/social/layout.tsx). That button awaited
// disconnectAccountAction and caught only a throw, but a disconnect that did
// not complete — X's tokens could not be cleared, the account was not found —
// RETURNS { ok: false, error }. The answer was dropped, the button settled, and
// the family took Bubaly's copy of its X tokens for gone.
//
// Driven through the real AccountRow, on hook slots, and the real action behind
// it against the in-memory database; the token clear is made to fail.
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const server = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/i18n/use-format', () => ({ useHydrationSafeFormat: () => ({ fmtDateTime: (iso: string) => iso }) }));
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
// The server side of the button: the real action, its session and database.
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => server.db, createServiceClient: () => server.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => server.ctx }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { AccountRow } = await import('@/components/social/account-row');

const FAMILY = 'f0000000-0000-4000-8000-000000000001';
const PARENT = 'a0000000-0000-4000-8000-000000000001';
const X_ACCOUNT = 'e0000000-0000-4000-8000-000000000001';
const stamps = { created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' };

/** A Free family (no subscription) whose parent connected X on Basic. */
function household(): InMemorySupabase {
  const db = createInMemorySupabase({ userId: PARENT, maxRows: 1000 });
  db.seed('families', [{ id: FAMILY, name: 'Rivera household', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [{ id: 'm-0', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, display_name: 'parent' }]);
  db.seed('social_accounts', [{
    id: X_ACCOUNT, family_id: FAMILY, user_id: PARENT, platform: 'x', status: 'connected', display_name: 'Rivera fair on X',
    handle: 'riverafair', provider_account_id: '123456789', last_error: null, last_synced_at: null, deleted_at: null,
    created_by: PARENT, updated_by: null, metadata: {}, ...stamps,
  }]);
  db.seed('social_account_tokens', [{
    id: X_ACCOUNT, account_id: X_ACCOUNT, family_id: FAMILY, platform: 'x', provider_account_id: '123456789',
    access_token_enc: 'sealed-access-token', refresh_token_enc: 'sealed-refresh-token',
    created_by: PARENT, updated_by: null, metadata: { x_state: 'connected' }, ...stamps,
  }]);
  return db;
}

const row = () => render(h.hooks, createElement(AccountRow, {
  id: X_ACCOUNT, platform: 'x', name: 'Rivera fair on X', status: 'connected', lastError: null, lastSyncedAt: null,
}));
const token = (db: InMemorySupabase) => db.table('social_account_tokens').find((r) => r.id === X_ACCOUNT)!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  server.ctx = { user: { id: PARENT, email: null }, memberships: [], active: { familyId: FAMILY, role: 'parent', member: { id: 'm-0' } } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Disconnect says when the account was not disconnected (N2-R1)', () => {
  it('X\'s tokens could not be cleared: the family is told, and the tokens are where they were', async () => {
    const db = household();
    server.db = withFaults(db, (table, calls) => (table === 'social_account_tokens' && calls.some((c) => c.method === 'update')
      ? { message: 'storage unavailable' } : null));
    await click(byName(row(), 'Disconnect', 'button'));
    expect(h.toasts.error).toEqual(['Could not disconnect that account.']);
    expect(token(db)).toMatchObject({ access_token_enc: 'sealed-access-token', refresh_token_enc: 'sealed-refresh-token' });
    expect(db.table('social_accounts')[0]).toMatchObject({ status: 'connected', deleted_at: null });
  });

  it('a disconnect that went through clears the tokens and reports nothing wrong', async () => {
    const db = household();
    server.db = db;
    await click(byName(row(), 'Disconnect', 'button'));
    expect(h.toasts.error).toEqual([]);
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null });
    expect(db.table('social_accounts')[0]).toMatchObject({ status: 'disconnected', deleted_at: expect.any(String) });
  });
});
