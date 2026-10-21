// One sync of a provider account at a time.
//
// Nothing claimed an account before syncing it. The scheduled run and a
// member's "Sync now" — and two scheduled runs sharing a batch, since both
// schedulers fire the route in the same minute — each read the account's
// mappings, each found no mapping for a new local event, and each created it
// at the provider: two copies in the family's real calendar, pulled back as two
// local events, and the losing run failing on the mapping the first had already
// written (0018's unique constraints refuse the second mapping, not the second
// remote event).
//
// `sync_status` doubles as the claim, as `calendar_feeds.last_status` does for
// feeds (lib/server/calendar-feeds.ts claimFeed): a compare-and-set to
// `syncing` on an account not already `syncing` wins exactly once under
// concurrent updates of the one row. An account found `syncing` is busy —
// unless its claim is older than ACCOUNT_SYNC_STALE_MS, the mark of a sync that
// died, which the next sync takes over with the same compare-and-set on the
// stale stamp. The engine's own finalization (`synced` on success, `error` on
// failure) is what releases it, and the release here is fenced on `syncing` so
// it changes nothing the engine already settled. No new column: `updated_at`,
// kept by the table's trigger and written here too, dates the claim.
//
// Taken by the two entry points that run a sync for a person's account —
// app/api/cron/provider-sync and app/api/sync/run — around `runProviderSync`
// rather than inside it, so the engine's item-level claims (the adoption
// fences in lib/sync/persistence.ts) keep covering the case this lease cannot:
// a stale takeover while the sync that died turns out to be alive.
import type { Database } from '@/lib/database.types';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { runProviderSync, type RunResult } from '@/lib/sync/engine/generic';
import type { createServiceClient } from '@/lib/supabase/server';
import { wroteNoRows } from '@/lib/supabase/errors';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; user_id: string | null; family_id: string; external_id: string | null };

export type LeasedRunResult = RunResult & {
  /** Another sync holds this account: nothing was done, and nothing failed. */
  busy?: boolean;
};

/**
 * A sync that has held its account this long died without releasing it (the
 * function killed at maxDuration, a crash before the finalization). Longer than
 * any one invocation can live, so a sync genuinely in flight is never taken
 * from under it.
 */
export const ACCOUNT_SYNC_STALE_MS = 20 * 60_000;

export async function claimAccountLease(admin: Admin, account: Account, now: Date = new Date()): Promise<'claimed' | 'busy'> {
  // `updated_at` is a stamp the table's trigger keeps, so the typed Update
  // leaves it out; written here too so the claim's age is explicit.
  const mark = { sync_status: 'syncing', updated_at: now.toISOString() } as unknown as Database['public']['Tables']['sync_accounts']['Update'];
  const claim = () => admin.from('sync_accounts').update(mark)
    .eq('id', account.id).eq('family_id', account.family_id).neq('sync_status', 'syncing').select('id');
  const idle = await claim();
  if (idle.error) throw new Error('Sync account lease failed');
  if (!wroteNoRows(idle.data)) return 'claimed';

  const { data: held, error: readError } = await admin.from('sync_accounts')
    .select('sync_status, updated_at').eq('id', account.id).eq('family_id', account.family_id).maybeSingle();
  if (readError || !held) throw new Error('Sync account lease read failed');
  if (held.sync_status !== 'syncing') {
    // Released between the attempt and this read: once more. A second miss on
    // an idle row is a row this client may not update.
    const again = await claim();
    if (again.error || wroteNoRows(again.data)) throw new Error('Sync account lease was refused');
    return 'claimed';
  }
  const heldSince = Date.parse(String(held.updated_at ?? ''));
  if (Number.isFinite(heldSince) && now.getTime() - heldSince < ACCOUNT_SYNC_STALE_MS) return 'busy';
  const cutoff = new Date(now.getTime() - ACCOUNT_SYNC_STALE_MS).toISOString();
  const stale = await admin.from('sync_accounts').update(mark)
    .eq('id', account.id).eq('family_id', account.family_id).eq('sync_status', 'syncing').lt('updated_at', cutoff).select('id');
  if (stale.error) throw new Error('Sync account stale-lease takeover failed');
  return wroteNoRows(stale.data) ? 'busy' : 'claimed';
}

/**
 * Give the account back. The engine's finalization normally has already:
 * zero rows here is the ordinary case, and only an error is reported.
 */
export async function releaseAccountLease(admin: Admin, account: Account, outcome: 'synced' | 'error'): Promise<void> {
  const { error } = await admin.from('sync_accounts')
    .update({ sync_status: outcome })
    .eq('id', account.id).eq('family_id', account.family_id).eq('sync_status', 'syncing').select('id');
  if (error) console.error('[sync] could not release the account lease', { accountId: account.id, error });
}

/** `runProviderSync` under the account's lease; `busy` when another sync holds it. */
export async function runLeasedProviderSync(admin: Admin, account: Account, adapter: SyncProviderAdapter): Promise<LeasedRunResult> {
  if (await claimAccountLease(admin, account) === 'busy') {
    return { imported: 0, exported: 0, skipped: 0, conflicts: 0, busy: true };
  }
  try {
    const result = await runProviderSync(admin, account, adapter);
    await releaseAccountLease(admin, account, result.error ? 'error' : 'synced');
    return result;
  } catch (e) {
    await releaseAccountLease(admin, account, 'error');
    throw e;
  }
}
