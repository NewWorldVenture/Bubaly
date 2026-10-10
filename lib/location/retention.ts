// lib/location/retention.ts — how long a member's position outlives the moment.
//
// Two rules, both run with the service role because clients may not delete or
// rewrite location history (0335 makes location_events append-only for them):
//
//   * A member who is removed from a family takes their position with them:
//     the live member_locations row is blanked, and the coordinates on their
//     location_events and safety_check_ins are cleared. The arrival timeline
//     (place, event, time) stays — it is the family's record, not a position.
//   * Nobody's history is kept forever: location_events older than the window
//     are deleted, and any coordinates still on newer ones (written before
//     events stopped storing them) or on old check-ins are cleared.
//
// The scheduled sweep also re-applies the first rule: a removal whose forget
// failed (a refused or timed-out write) used to leave the live row behind for
// good, because nothing ever came back for member_locations — the removed
// member's last position stayed readable by, and plotted for, the family they
// left. The sweep now blanks any live row whose member is no longer active.
//
// If a database-level guarantee is wanted, the same member rule belongs in a
// trigger on family_members.is_active going false — reported, not written here.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeActionError } from '@/lib/supabase/errors';

/** Days a location event (arrived/left) is kept at all. */
export const LOCATION_EVENT_RETENTION_DAYS = 90;
/** Removed members' live rows the sweep repairs per run; a repair is rare, so this is never reached. */
const REMOVED_MEMBER_SWEEP_LIMIT = 500;

type Failure = { step: string; message: string };
export type LocationForgetResult = { ok: true } | { ok: false; failures: Failure[] };

/** What a blanked live row says: nothing. */
const CLEARED_POSITION = { is_sharing: false, latitude: null, longitude: null, address: null, accuracy_m: null, battery: null, place_id: null } as const;

// Described, not repeated: a failure here is logged by the callers and counted
// by the cron's response, and the raw Postgres string belongs in neither.
const failureOf = (step: string, error: unknown): Failure[] =>
  error ? [{ step, message: describeActionError(error, 'The location record could not be updated.') }] : [];

/** Blank everything a removed member's rows say about where they were. */
export async function forgetMemberLocation(
  service: SupabaseClient,
  familyId: string,
  memberId: string,
): Promise<LocationForgetResult> {
  const [live, events, checkIns] = await Promise.all([
    service.from('member_locations')
      .update(CLEARED_POSITION)
      .eq('family_id', familyId).eq('member_id', memberId).select('member_id'),
    service.from('location_events')
      .update({ latitude: null, longitude: null })
      .eq('family_id', familyId).eq('member_id', memberId).select('id'),
    service.from('safety_check_ins')
      .update({ latitude: null, longitude: null })
      .eq('family_id', familyId).eq('member_id', memberId).select('id'),
  ]);
  const failures = [
    ...failureOf('member_locations', live.error),
    ...failureOf('location_events', events.error),
    ...failureOf('safety_check_ins', checkIns.error),
  ];
  return failures.length ? { ok: false, failures } : { ok: true };
}

/**
 * Live rows a removed member left behind: still sharing, or still holding a
 * position, with a family_members row that is no longer active. The join is
 * the embedded filter — PostgREST drops the parent row when the `!inner`
 * embed does not match — so this never reads every member's position or
 * every removed member; only the rows that still say something.
 */
async function clearRemovedMemberLocations(service: SupabaseClient): Promise<{ cleared: number; failures: Failure[] }> {
  const stale = () => service.from('member_locations')
    .select('member_id, member:family_members!inner(is_active)')
    .eq('member.is_active', false)
    .limit(REMOVED_MEMBER_SWEEP_LIMIT);
  const [sharing, positioned] = await Promise.all([
    stale().eq('is_sharing', true),
    stale().not('latitude', 'is', null),
  ]);
  const failures = [
    ...failureOf('read removed members still sharing (member_locations)', sharing.error),
    ...failureOf('read removed members with a position (member_locations)', positioned.error),
  ];
  const ids = new Set<string>();
  for (const rows of [sharing.error ? [] : sharing.data ?? [], positioned.error ? [] : positioned.data ?? []]) {
    for (const row of rows as Array<{ member_id?: unknown }>) if (typeof row.member_id === 'string') ids.add(row.member_id);
  }
  if (ids.size === 0) return { cleared: 0, failures };
  const cleared = await service.from('member_locations')
    .update(CLEARED_POSITION)
    .in('member_id', [...ids])
    .select('member_id');
  return {
    cleared: cleared.error ? 0 : cleared.data?.length ?? 0,
    failures: [...failures, ...failureOf('clear removed members (member_locations)', cleared.error)],
  };
}

export type LocationRetentionResult = {
  ok: boolean; purgedEvents: number; clearedEvents: number; clearedCheckIns: number; clearedRemovedMembers: number; failures: Failure[];
};

/** The scheduled sweep: drop old events, clear coordinates nothing needs, and blank what a removed member left behind. */
export async function enforceLocationRetention(service: SupabaseClient, now = new Date()): Promise<LocationRetentionResult> {
  const cutoff = new Date(now.getTime() - LOCATION_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const purged = await service.from('location_events').delete().lt('occurred_at', cutoff).select('id');
  const cleared = await service.from('location_events')
    .update({ latitude: null, longitude: null }).not('latitude', 'is', null).select('id');
  const checkIns = await service.from('safety_check_ins')
    .update({ latitude: null, longitude: null }).lt('created_at', cutoff).not('latitude', 'is', null).select('id');
  const removed = await clearRemovedMemberLocations(service);
  const failures = [
    ...failureOf('purge location_events', purged.error),
    ...failureOf('clear location_events coordinates', cleared.error),
    ...failureOf('clear safety_check_ins coordinates', checkIns.error),
    ...removed.failures,
  ];
  return {
    ok: failures.length === 0,
    purgedEvents: purged.data?.length ?? 0,
    clearedEvents: cleared.data?.length ?? 0,
    clearedCheckIns: checkIns.data?.length ?? 0,
    clearedRemovedMembers: removed.cleared,
    failures,
  };
}
