import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// Removing a member is a soft `is_active = false`; nothing touches their
// sync_accounts. The provider-sync cron runs on the service role and selected
// every enabled account with no membership check, so a removed member's
// calendar kept importing into the household (and the household's events kept
// exporting to them) on every tick — with no one able to disconnect it. The
// cron now switches such a connection off instead of syncing it.

const state = vi.hoisted(() => ({ db: null as unknown, ran: [] as string[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ provider: 'google', isConfigured: () => true }) }));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_admin: unknown, account: { id: string }) => {
    state.ran.push(account.id);
    return { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  },
}));

const { GET } = await import('@/app/api/cron/provider-sync/route');
let db: InMemorySupabase;

beforeEach(() => {
  state.ran = [];
  db = createInMemorySupabase();
  state.db = db;
  db.seed('sync_accounts', [
    { id: 'removed', user_id: 'b', family_id: 'fam', provider: 'google', external_id: 'b@x', sync_direction: 'two_way', last_synced_at: null },
    { id: 'member', user_id: 'a', family_id: 'fam', provider: 'google', external_id: 'a@x', sync_direction: 'two_way', last_synced_at: null },
  ]);
  db.seed('sync_connections', [
    { id: 'c-removed', account_id: 'removed', family_id: 'fam', sync_direction: 'two_way' },
    { id: 'c-member', account_id: 'member', family_id: 'fam', sync_direction: 'two_way' },
  ]);
  db.seed('family_members', [
    { id: 'mb', family_id: 'fam', user_id: 'b', role: 'adult', is_active: false },
    { id: 'ma', family_id: 'fam', user_id: 'a', role: 'parent', is_active: true },
  ]);
});

describe('the provider-sync cron and a removed member', () => {
  it("does not sync the removed member's connection, and switches it off", async () => {
    const res = await GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'));
    expect(res.status).toBe(200);
    expect(state.ran).toEqual(['member']);
    expect(db.table('sync_accounts').find((a) => a.id === 'removed')!.sync_direction).toBe('disabled');
    expect(db.table('sync_connections').find((c) => c.id === 'c-removed')!.sync_direction).toBe('disabled');
    // The active member's connection is untouched (control).
    expect(db.table('sync_accounts').find((a) => a.id === 'member')!.sync_direction).toBe('two_way');
  });
});
