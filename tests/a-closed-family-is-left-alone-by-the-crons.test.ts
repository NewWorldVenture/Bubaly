import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A family that closed its account (families.closed_at) is left alone by the
 * scheduled jobs. closeAccountAction set closed_at and nothing read it: the
 * push scan kept generating and pushing to the family's devices, provider sync
 * kept using their stored OAuth tokens, and the allowance cron kept crediting
 * wallets for any family whose subscription row still said paid. (The weekly
 * digest's half is in the-weekly-digest-reaches-every-family.test.ts.)
 */

const OPEN = 'family-open';
const CLOSED = 'family-closed';
const TODAY = '2026-09-28';
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

const harness = vi.hoisted(() => ({
  db: null as unknown,
  generatedFor: [] as string[],
  syncedFor: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/notifications', () => ({
  generateFamilyNotifications: async (_db: unknown, familyId: string) => { harness.generatedFor.push(familyId); return 0; },
}));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => null }));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, failed: 0 } }) }));
vi.mock('@/lib/server/push', () => ({
  dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }),
}));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ isConfigured: () => true }) }));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_db: unknown, account: { family_id: string }) => {
    harness.syncedFor.push(account.family_id);
    return { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  },
}));

const { GET: pushScan } = await import('@/app/api/cron/push-scan/route');
const { GET: providerSync } = await import('@/app/api/cron/provider-sync/route');
const { GET: walletAllowance } = await import('@/app/api/cron/wallet-allowance/route');

const request = () => new Request('https://bubaly.test/api/cron') as never;
let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.generatedFor = [];
  harness.syncedFor = [];
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('families', [
    { id: OPEN, trial_ends_at: null, closed_at: null },
    { id: CLOSED, trial_ends_at: null, closed_at: '2026-09-01T00:00:00.000Z' },
  ]);
  for (const family of [OPEN, CLOSED]) {
    db.seed('subscriptions', [{ family_id: family, plan: 'basic', status: 'active' }]);
    db.seed('family_members', [{ id: `parent-${family}`, family_id: family, user_id: `user-${family}`, role: 'parent', is_active: true }]);
    db.seed('child_wallets', [{ id: `wallet-${family}`, family_id: family, member_id: `child-${family}` }]);
    db.seed('wallet_buckets', KINDS.map((kind) => ({ id: `wallet-${family}-${kind}`, family_id: family, child_wallet_id: `wallet-${family}`, kind })));
    db.seed('allowance_rules', [{
      id: `rule-${family}`, family_id: family, child_wallet_id: `wallet-${family}`, amount_cents: 1_500, cadence: 'weekly', split: null,
      is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21', created_by: `user-${family}`,
    }]);
    db.seed('sync_accounts', [{
      id: `sync-${family}`, user_id: `user-${family}`, family_id: family, external_id: 'x', provider: 'google',
      sync_direction: 'two_way', last_synced_at: null,
    }]);
  }
});

afterEach(() => { vi.useRealTimers(); });

describe('a closed family is left alone by the scheduled jobs', () => {
  it('push-scan generates nothing for a closed family', async () => {
    const res = await pushScan(request());
    expect((await res.json()).families).toBe(1);
    expect(harness.generatedFor).toEqual([OPEN]);
  });

  it('provider-sync does not sync a closed family\'s accounts', async () => {
    const res = await providerSync(request());
    expect((await res.json()).scanned).toBe(1);
    expect(harness.syncedFor).toEqual([OPEN]);
  });

  it('wallet-allowance does not pay a closed family\'s allowance, even on a paid plan', async () => {
    await walletAllowance(request());
    const paidFamilies = new Set(db.table('wallet_transactions').map((t) => t.family_id));
    expect([...paidFamilies]).toEqual([OPEN]);
    expect(db.table('allowance_rules').find((r) => r.id === `rule-${CLOSED}`)?.next_run_on).toBe(TODAY);
  });
});
