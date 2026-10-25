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
// Taken by every entry point that runs a sync for a person's account, around
// the engine rather than inside it: app/api/cron/provider-sync and
// app/api/sync/run around `runProviderSync` (runLeasedProviderSync), and the
// Google account page's "Sync now", app/api/sync/google/sync, around
// `runGoogleSync` (runUnderAccountLease). That page renders its own control,
// and its route ran the Google engine with no claim: a press during the
// scheduled run synced the account twice at once, and its success stamp
// released the scheduled sync's lease mid-run. Outside the engine so the
// engine's item-level claims (the adoption fences in lib/sync/persistence.ts)
// keep covering the case this lease cannot: a stale takeover while the sync
// that died turns out to be alive.
import type { Database, SyncStatusEnum } from '@/lib/database.types';
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

/**
 * A claim taken, and the stamp it replaced when that is known: the account's
 * own status before this sync, which a sync the policy refuses before it
 * starts gives back (releaseAccountLease). Null after a stale takeover, or when
 * the stamp could not be read: there is no state of the account's own to give back.
 */
export type AccountClaim = { prior: Exclude<SyncStatusEnum, 'syncing'> | null };

export async function claimAccountLease(admin: Admin, account: Account, now: Date = new Date()): Promise<AccountClaim | 'busy'> {
  // `updated_at` is a stamp the table's trigger keeps, so the typed Update
  // leaves it out; written here too so the claim's age is explicit.
  const mark = { sync_status: 'syncing', updated_at: now.toISOString() } as unknown as Database['public']['Tables']['sync_accounts']['Update'];
  const claim = () => admin.from('sync_accounts').update(mark)
    .eq('id', account.id).eq('family_id', account.family_id).neq('sync_status', 'syncing').select('id');
  // What the claim is about to replace. The dashboards show this stamp
  // verbatim ("Connected synced"), and a sync the account's policy refuses
  // never runs, so it should leave the stamp as it found it. Read for that
  // alone: a read that fails costs only that (the release then stamps
  // `error`, as before), never the sync.
  const { data: before, error: beforeError } = await admin.from('sync_accounts').select('sync_status')
    .eq('id', account.id).eq('family_id', account.family_id);
  const seen = beforeError ? undefined : (before as { sync_status?: SyncStatusEnum }[] | null)?.[0]?.sync_status;
  const prior = seen && seen !== 'syncing' ? seen : null;
  const idle = await claim();
  if (idle.error) throw new Error('Sync account lease failed');
  if (!wroteNoRows(idle.data)) return { prior };

  const { data: held, error: readError } = await admin.from('sync_accounts')
    .select('sync_status, updated_at').eq('id', account.id).eq('family_id', account.family_id).maybeSingle();
  if (readError || !held) throw new Error('Sync account lease read failed');
  if (held.sync_status !== 'syncing') {
    // Released between the attempt and this read: once more. A second miss on
    // an idle row is a row this client may not update.
    const again = await claim();
    if (again.error || wroteNoRows(again.data)) throw new Error('Sync account lease was refused');
    return { prior: held.sync_status };
  }
  const heldSince = Date.parse(String(held.updated_at ?? ''));
  if (Number.isFinite(heldSince) && now.getTime() - heldSince < ACCOUNT_SYNC_STALE_MS) return 'busy';
  const cutoff = new Date(now.getTime() - ACCOUNT_SYNC_STALE_MS).toISOString();
  const stale = await admin.from('sync_accounts').update(mark)
    .eq('id', account.id).eq('family_id', account.family_id).eq('sync_status', 'syncing').lt('updated_at', cutoff).select('id');
  if (stale.error) throw new Error('Sync account stale-lease takeover failed');
  return wroteNoRows(stale.data) ? 'busy' : { prior: null };
}

/**
 * Give the account back. The engine's finalization normally has already:
 * zero rows here is the ordinary case, and only an error is reported.
 */
export async function releaseAccountLease(admin: Admin, account: Account, outcome: Exclude<SyncStatusEnum, 'syncing'>): Promise<void> {
  const { error } = await admin.from('sync_accounts')
    .update({ sync_status: outcome })
    .eq('id', account.id).eq('family_id', account.family_id).eq('sync_status', 'syncing').select('id');
  if (error) console.error('[sync] could not release the account lease', { accountId: account.id, error });
}

/**
 * One engine's sync of `account` under the account's lease; `busy`, with
 * nothing run, when another sync holds it. `sync` reports a refusal by its
 * policy as `refused`, as both engines do, so a sync that never started gives
 * the account back as it found it.
 */
export async function runUnderAccountLease(admin: Admin, account: Account, sync: () => Promise<RunResult>): Promise<LeasedRunResult> {
  const lease = await claimAccountLease(admin, account);
  if (lease === 'busy') {
    return { imported: 0, exported: 0, skipped: 0, conflicts: 0, busy: true };
  }
  try {
    const result = await sync();
    // A sync the account's policy refused (turned off, an import still to be
    // finished, an owner no longer in the family) never started: it gives the
    // account back as it found it. Stamping it `error` told the dashboards
    // "Connected error" about a sync a parent had switched off. A sync that ran
    // and failed is the account's error state, as before.
    const outcome = result.refused && lease.prior ? lease.prior : result.error ? 'error' : 'synced';
    await releaseAccountLease(admin, account, outcome);
    return result;
  } catch (e) {
    await releaseAccountLease(admin, account, 'error');
    throw e;
  }
}

/** `runProviderSync` under the account's lease; `busy` when another sync holds it. */
export function runLeasedProviderSync(admin: Admin, account: Account, adapter: SyncProviderAdapter): Promise<LeasedRunResult> {
  return runUnderAccountLease(admin, account, () => runProviderSync(admin, account, adapter));
}
