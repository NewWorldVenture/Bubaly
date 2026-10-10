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
//     Its cron route is held out of the deployable tree, at
//     held/api/cron/location-retention/route.ts (Next does not route held/), and
//     unscheduled, pending the owner's retention decision; until then nothing
//     runs the sweep.
//
// If a database-level guarantee is wanted, the same member rule belongs in a
// trigger on family_members.is_active going false — reported, not written here.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeActionError } from '@/lib/supabase/errors';

/** Days a location event (arrived/left) is kept at all. */
export const LOCATION_EVENT_RETENTION_DAYS = 90;

type Failure = { step: string; message: string };
export type LocationForgetResult = { ok: true } | { ok: false; failures: Failure[] };

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
      .update({ is_sharing: false, latitude: null, longitude: null, address: null, accuracy_m: null, battery: null, place_id: null })
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

export type LocationRetentionResult = {
  ok: boolean; purgedEvents: number; clearedEvents: number; clearedCheckIns: number; failures: Failure[];
};

/** The retention sweep: drop old events, clear coordinates nothing needs. */
export async function enforceLocationRetention(service: SupabaseClient, now = new Date()): Promise<LocationRetentionResult> {
  const cutoff = new Date(now.getTime() - LOCATION_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const purged = await service.from('location_events').delete().lt('occurred_at', cutoff).select('id');
  const cleared = await service.from('location_events')
    .update({ latitude: null, longitude: null }).not('latitude', 'is', null).select('id');
  const checkIns = await service.from('safety_check_ins')
    .update({ latitude: null, longitude: null }).lt('created_at', cutoff).not('latitude', 'is', null).select('id');
  const failures = [
    ...failureOf('purge location_events', purged.error),
    ...failureOf('clear location_events coordinates', cleared.error),
    ...failureOf('clear safety_check_ins coordinates', checkIns.error),
  ];
  return {
    ok: failures.length === 0,
    purgedEvents: purged.data?.length ?? 0,
    clearedEvents: cleared.data?.length ?? 0,
    clearedCheckIns: checkIns.data?.length ?? 0,
    failures,
  };
}
