// A family's leave, or a contributing scope switched off, as one step the
// nightly aggregation cannot interleave with.
//
// The module wrote consent and deleted the stored contribution from the
// browser, and the nightly run (aggregate-server.ts) knew nothing of either. A
// run that had read consent before the leave wrote the family's row back after
// the delete and counted it in a NEW publication, after the family had been
// told it had left. Now both writes are made while holding the publication
// claim (NETWORK_PUBLICATION_LEASE_KEY) the aggregation publishes under, and
// the aggregation re-reads consent under that claim before it publishes, and
// after its own upserts whether or not it holds it. So once this returns:
//   - no write leaves the family's contribution (or a switched-off scope's
//     metrics) stored. The delete here follows the consent write, and any
//     upsert after the delete is followed by a run's re-check, which sees it.
//   - no publication written after this returned includes it. One written
//     while this waited for the claim came before the consent write, and every
//     later one re-read consent under the claim first.
// A snapshot published BEFORE the withdrawal stays for its epoch, as designed
// (aggregate.ts, PUBLICATION_EPOCH), and the module's copy says so.
//
// Both writes go through the caller's OWN client, so RLS still decides who may
// change consent (0353: managers only). The service client touches the claim
// in app_settings and nothing else.
//
// When the claim is not had within the wait (a run publishing a large network,
// a holder that died and keeps it until its ten-minute ttl, or a claim that
// cannot be read), the withdrawal is written anyway. A leave is never dropped,
// and never held for minutes behind a crashed cron: the first guarantee above
// does not depend on the claim. `fenced: false` says that only the second is
// unproven, and the module tells the family that a monthly update in progress
// at that moment may still include them until next month's.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { releaseLease, type LeaseClaim } from '@/lib/server/app-settings-lease';
import { wroteNoRows } from '@/lib/supabase/errors';
import { claimNetworkPublication, NETWORK_PUBLICATION_LEASE_KEY, PUBLICATION_CLAIM_RETRY_MS } from './aggregate-server';
import type { ConsentScope } from './insights';

type DB = SupabaseClient<Database>;
type Consent = Tables<'network_consent'>;

/** Leaving the network, or the scopes after one that contributes was switched off. */
export type NetworkWithdrawal = { leave: true } | { scopes: Partial<Record<ConsentScope, boolean>> };

export type WithdrawalOutcome =
  /** `fenced`: written while holding the publication claim. */
  | { status: 'withdrawn'; rows: Consent[]; fenced: boolean }
  /** The consent write matched no row: RLS filtered it, or the family is not in the network. */
  | { status: 'not_saved' }
  | { status: 'consent_failed'; error: unknown }
  /** Consent is withdrawn, the stored row is not deleted yet (the nightly prune deletes it). */
  | { status: 'forget_failed'; error: unknown; rows: Consent[] };

/**
 * How long a withdrawal waits for the claim: sixteen tries 250 ms apart, about
 * four seconds. The aggregation holds it from its consent re-check to the end
 * of its publish, a few statements, so this outlasts an ordinary holder.
 */
export const WITHDRAWAL_CLAIM_ATTEMPTS = 16;
export const WITHDRAWAL_WAIT_MS = WITHDRAWAL_CLAIM_ATTEMPTS * PUBLICATION_CLAIM_RETRY_MS;

export async function withdrawFromNetwork(
  user: DB,
  /** Null when no service client could be made: the withdrawal is still written, unfenced. */
  service: DB | null,
  who: { familyId: string; userId: string },
  change: NetworkWithdrawal,
): Promise<WithdrawalOutcome> {
  const lease: LeaseClaim = service
    ? await claimNetworkPublication(service, { attempts: WITHDRAWAL_CLAIM_ATTEMPTS, now: () => new Date() })
    : { claimed: false, reason: 'error' };
  try {
    const { data: saved, error } = 'leave' in change
      ? await user.from('network_consent').upsert({
        family_id: who.familyId, enabled: false, scopes: {}, consented_by: null, consented_at: null,
      }, { onConflict: 'family_id' }).select('*')
      // A scope switch records the manager who made it as the consent's
      // author (consentsByNonManagers), and never writes `enabled`: it changes
      // nothing for a family that is no longer in the network.
      : await user.from('network_consent')
        .update({ scopes: change.scopes, consented_by: who.userId, consented_at: new Date().toISOString() })
        .eq('family_id', who.familyId).eq('enabled', true).select('*');
    if (error) return { status: 'consent_failed', error };
    if (wroteNoRows(saved)) return { status: 'not_saved' };
    // After the consent write, never before it: the aggregation's re-check
    // reads consent after its upserts, so an upsert that follows this delete
    // is caught by a read that sees the withdrawal. Zero rows is the ordinary
    // answer for a family that has not contributed yet.
    const { error: forgetError } = await user.from('network_contributions')
      .delete().eq('family_id', who.familyId).select('family_id');
    if (forgetError) return { status: 'forget_failed', error: forgetError, rows: saved };
    return { status: 'withdrawn', rows: saved, fenced: lease.claimed };
  } finally {
    if (lease.claimed && service) await releaseLease(service, NETWORK_PUBLICATION_LEASE_KEY, lease.token);
  }
}
