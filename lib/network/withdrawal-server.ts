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
//     metrics) stored, with the two exceptions below. The delete here follows
//     the consent write, and any upsert after the delete is followed by a
//     run's re-check, which sees it.
//   - no publication written after this returned includes it. One written
//     while this waited for the claim came before the consent write, and every
//     later one re-read consent under the claim first.
// A snapshot published BEFORE the withdrawal stays for its epoch, as designed
// (aggregate.ts, PUBLICATION_EPOCH), and the module's copy says so.
//
// The two exceptions app code cannot close; the owner's admission trigger on
// network_contributions (a consent check under a row lock) closes both. Each
// keeps the row stored until the next night's run prunes it in its step 2,
// and in neither is it ever published: the figures are held for the epoch,
// and a run publishes only the families it re-checked under the claim.
//   - A run that dies after upserting the family's row and before its
//     re-check: the cron route has a maxDuration of 60 seconds and upserts one
//     family at a time, and nothing re-checks for a run that was killed, nor
//     for one that throws out to the route's catch.
//   - An upsert whose answer is lost on the way back and that commits at the
//     database after the re-check has read consent.
//
// Both writes go through the caller's OWN client, so RLS still decides who may
// change consent (0353: managers only). The service client touches the claim
// in app_settings, and the claim's rate limit, and nothing else.
//
// When the claim is not had within the wait (a run publishing a large network,
// a holder that died and keeps it until its ten-minute ttl, a claim that
// cannot be read, or a member past their claim limit), the withdrawal is
// written anyway. A leave is never dropped, and never held for minutes behind
// a crashed cron: the first guarantee above does not depend on the claim.
// `fenced: false` says that only the second is unproven, and the module tells
// the family that a monthly update in progress at that moment may still
// include them until next month's.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { releaseLease, type LeaseClaim } from '@/lib/server/app-settings-lease';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { wroteNoRows } from '@/lib/supabase/errors';
import { claimNetworkPublication, NETWORK_PUBLICATION_LEASE_KEY, PUBLICATION_CLAIM_RETRY_MS } from './aggregate-server';
import type { ConsentScope } from './insights';

type DB = SupabaseClient<Database>;
type Consent = Tables<'network_consent'>;

/**
 * Leaving the network, or the scopes a switch-off turns off. A withdrawal only
 * ever narrows: it never switches a scope on (narrowScopes).
 */
export type NetworkWithdrawal = { leave: true } | { scopesOff: ConsentScope[] };

export type WithdrawalOutcome =
  /** `fenced`: written while holding the publication claim. */
  | { status: 'withdrawn'; rows: Consent[]; fenced: boolean }
  /** The consent write matched no row: RLS filtered it, the family is not in the network, or its scopes changed meanwhile. */
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

/**
 * How often one member may take the publication claim, across every household
 * they manage; a household's own claims are bounded by its managers'.
 *
 * The claim is global, and a run that meets a withdrawal holding it waits and
 * then fails the night (aggregate-server.ts, RUN_WAITS_FOR_A_WITHDRAWAL_ATTEMPTS).
 * Unlimited, a manager calling the action in a loop around the cron's hour
 * kept the night's figures unwritten. Ten in ten minutes is far past what a
 * person switching options does. Past it the withdrawal is STILL written, only
 * without the claim (`fenced: false`): consent is never refused. A limiter
 * that cannot answer lets the claim be taken, as before the limit existed.
 * The key names the member, so rate_limit_hit (0179) accepts it on any client.
 */
export const WITHDRAWAL_CLAIMS_PER_WINDOW = 10;
export const WITHDRAWAL_CLAIM_WINDOW_MS = 10 * 60_000;

async function mayClaim(service: DB, who: { familyId: string; userId: string }): Promise<boolean> {
  const limits = { limit: WITHDRAWAL_CLAIMS_PER_WINDOW, windowMs: WITHDRAWAL_CLAIM_WINDOW_MS, failOpen: true };
  return (await rateLimitDb(service, `network-publication-claim:user:${who.userId}`, limits)).ok;
}

/**
 * Switch `off` off in the scopes STORED now, and nothing else.
 *
 * The module built the whole next map from the row it loaded, and this wrote
 * that map as given. network_consent is not realtime, so a second tab of the
 * same household still held the map from before a switch-off made in the
 * first, and its switch-off of another scope wrote the first one back on:
 * benchmarks, confirmed off and its stored row deleted, contributing again
 * the next night. Built from the stored map, a stale tab's switch-off can only
 * narrow, and a scope it still shows as off, switched on elsewhere since,
 * stays on. The update is a compare-and-set on the map read: one changed in
 * between matches no row, and the member is asked to refresh.
 */
async function narrowScopes(user: DB, who: { familyId: string; userId: string }, off: ConsentScope[]) {
  const { data: current, error } = await user.from('network_consent')
    .select('scopes').eq('family_id', who.familyId).eq('enabled', true).maybeSingle();
  if (error) return { data: null, error };
  // Not in the network (or not this member's to read): nothing to narrow.
  if (!current) return { data: [] as Consent[], error: null };
  const stored = current.scopes && typeof current.scopes === 'object' && !Array.isArray(current.scopes)
    ? current.scopes as Record<string, unknown> : {};
  const scopes: Record<string, unknown> = { ...stored };
  for (const scope of off) scopes[scope] = false;
  return user.from('network_consent')
    .update({ scopes: scopes as Consent['scopes'], consented_by: who.userId, consented_at: new Date().toISOString() })
    .eq('family_id', who.familyId).eq('enabled', true).eq('scopes', JSON.stringify(current.scopes))
    .select('*');
}

export async function withdrawFromNetwork(
  user: DB,
  /** Null when no service client could be made: the withdrawal is still written, unfenced. */
  service: DB | null,
  who: { familyId: string; userId: string },
  change: NetworkWithdrawal,
): Promise<WithdrawalOutcome> {
  const lease: LeaseClaim = service && await mayClaim(service, who)
    ? await claimNetworkPublication(service, { holder: 'withdrawal', attempts: WITHDRAWAL_CLAIM_ATTEMPTS, now: () => new Date() })
    : { claimed: false, reason: 'error' };
  try {
    const { data: saved, error } = 'leave' in change
      ? await user.from('network_consent').upsert({
        family_id: who.familyId, enabled: false, scopes: {}, consented_by: null, consented_at: null,
      }, { onConflict: 'family_id' }).select('*')
      // A scope switch records the manager who made it as the consent's
      // author (consentsByNonManagers), and never writes `enabled`: it changes
      // nothing for a family that is no longer in the network.
      : await narrowScopes(user, who, change.scopesOff);
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
    if (lease.claimed && service) await releaseLease(service, NETWORK_PUBLICATION_LEASE_KEY, lease.token, 'withdrawal');
  }
}
