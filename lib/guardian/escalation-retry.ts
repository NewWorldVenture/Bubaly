// lib/guardian/escalation-retry.ts — the second chance for an emergency alert
// that reached nobody.
//
// escalateGuardianEmergency answers `undelivered` (or `interrupted`) when every
// text and call to every manager failed, records the escalation with nobody
// notified, and gives its claim back "so a retry can try again". Nothing asked
// for one. The SMS lane completed its receipt, the WhatsApp route marked its
// callback processed and answered 200, the screening route's after() task only
// logged; Twilio never redelivers a 200, the SMS recovery cron sweeps receipts
// and not escalations, and no cron or queue re-read guardian_escalations. So a
// brief Twilio outage at the moment of a critical emergency abandoned the one
// alert that reaches a phone face-down in another room.
//
// This re-attempts them from the record. Every input the escalation needs is
// on the row it wrote — family, communication, type, severity, description,
// caller — and the escalation is keyed on those same values (the communication
// id when there is one, otherwise a hash of the rest, so the description is
// passed VERBATIM), so the retry claims the same ledger id, lands in the same
// row, and skips the in-app notification it already wrote. A partial success
// is `delivered` with the reached managers recorded, which this never touches:
// nobody is texted twice. Run from the Guardian recovery cron.
//
// It is the ONLY retrier of a recorded escalation that reached nobody, and it
// is finite: a record older than the window, an acknowledged one, and one the
// escalation marked `unreachable` (nobody to text or call — no manager phone on
// file, or Twilio not configured — written with notified_member_ids NULL rather
// than empty) are not re-attempted. The inbound lanes complete such messages
// rather than answering 503 for them, because their own retry (the receipt
// drain and Twilio's redelivery) has no deadline.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { escalateGuardianEmergency } from './escalate';
import type { GuardianEscalationInput } from './escalation';
import { smsStep } from './sms-deadline';

/** How far back a record that reached nobody is still re-attempted. */
export const GUARDIAN_ESCALATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One text plus one call per manager, fanned out together, around a handful of reads and writes. */
const ATTEMPT_MS = 30_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['emergency_call', 'medical', 'police', 'fire', 'child_safety', 'urgent_personal'] as const;
const SEVERITIES = ['high', 'critical'] as const;

export type GuardianEscalationRetryCounts = {
  /** Records re-attempted this run. */
  examined: number;
  /** A manager was reached. */
  delivered: number;
  /** Another worker holds the escalation, or it completed between the read and the attempt. */
  duplicate: number;
  /** Still nobody reached (or cut off before anyone was); left for the next run. */
  undelivered: number;
  /**
   * Nobody to text or call any more (a manager's phone was removed, or Twilio
   * is unconfigured now). The record is marked so, and not re-attempted again.
   */
  unreachable: number;
  /** The ledger could not be read, a record was malformed, or the attempt itself could not complete. */
  unavailable: number;
};

const COLUMNS = 'id, family_id, communication_id, escalation_type, severity, description, caller_number, notified_member_ids';

/** The escalation's input, rebuilt from its own record; null when the record cannot be trusted to rebuild it. */
function inputFrom(row: Record<string, unknown>): GuardianEscalationInput | null {
  const { family_id, communication_id, escalation_type, severity, description, caller_number } = row;
  if (typeof family_id !== 'string' || !UUID.test(family_id)) return null;
  if (communication_id !== null && communication_id !== undefined && (typeof communication_id !== 'string' || !UUID.test(communication_id))) return null;
  if (!TYPES.includes(escalation_type as typeof TYPES[number]) || !SEVERITIES.includes(severity as typeof SEVERITIES[number])) return null;
  if (typeof description !== 'string' || !description.trim() || description.length > 4096) return null;
  if (caller_number !== null && caller_number !== undefined && (typeof caller_number !== 'string' || caller_number.length > 64)) return null;
  return {
    familyId: family_id,
    ...(typeof communication_id === 'string' ? { commId: communication_id } : {}),
    escalationType: escalation_type as typeof TYPES[number],
    severity: severity as typeof SEVERITIES[number],
    description,
    ...(typeof caller_number === 'string' ? { callerNumber: caller_number } : {}),
  };
}

/**
 * Re-attempt every recent, unacknowledged escalation whose record says no
 * manager was reached. Oldest first; bounded in number and per attempt; never
 * throws — a ledger that cannot be read is counted as unavailable, so the cron
 * answers non-2xx rather than claiming an empty sweep.
 */
export async function retryUndeliveredGuardianEscalations(
  client: SupabaseClient,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<GuardianEscalationRetryCounts> {
  const counts: GuardianEscalationRetryCounts = { examined: 0, delivered: 0, duplicate: 0, undelivered: 0, unreachable: 0, unavailable: 0 };
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
  const since = new Date(Date.now() - GUARDIAN_ESCALATION_RETRY_WINDOW_MS).toISOString();
  let rows: Record<string, unknown>[];
  try {
    // "Reached nobody" is `sms_sent = false AND call_attempted = false`: a
    // member is recorded as notified only when a text or call to them went
    // through, so the two flags are false exactly when notified_member_ids is
    // empty — and they are plain booleans a filter can ask for. A NULL
    // notified_member_ids is the escalation's own mark for "nobody to text or
    // call" (lib/guardian/escalate.ts, `unreachable`): no phone on file is not
    // mended by trying again, so those are left out here rather than re-run
    // every five minutes for a day.
    const { data, error } = await client.from('guardian_escalations')
      .select(COLUMNS)
      .is('acknowledged_at', null)
      .eq('sms_sent', false)
      .eq('call_attempted', false)
      .not('notified_member_ids', 'is', null)
      .gte('escalated_at', since)
      .order('escalated_at', { ascending: true })
      .limit(limit);
    if (error || !Array.isArray(data)) {
      console.error('[guardian] undelivered escalations could not be read for a retry', { error });
      counts.unavailable += 1;
      return counts;
    }
    rows = data as Record<string, unknown>[];
  } catch (error) {
    console.error('[guardian] undelivered escalations could not be read for a retry', { error });
    counts.unavailable += 1;
    return counts;
  }

  for (const row of rows) {
    if (options.signal?.aborted) break;
    const notified = row.notified_member_ids;
    if (Array.isArray(notified) && notified.length > 0) continue;
    const input = inputFrom(row);
    if (!input) {
      console.error('[guardian] an undelivered escalation record cannot be re-attempted as written', { id: row.id });
      counts.unavailable += 1;
      continue;
    }
    counts.examined += 1;
    try {
      // The same bound the SMS lane runs the escalation under, and the same
      // signal plumbing: the attempt stops at its deadline rather than running
      // on detached, and a cut-off is `interrupted`, not a success.
      const outcome = await smsStep(options.signal, (signal) => escalateGuardianEmergency(client, input, { signal }), ATTEMPT_MS);
      switch (outcome.kind) {
        case 'delivered': counts.delivered += 1; break;
        case 'duplicate': counts.duplicate += 1; break;
        case 'undelivered':
        case 'interrupted': counts.undelivered += 1; break;
        // The escalation re-wrote the record with notified_member_ids NULL and
        // marked its claim processed, so the next read leaves it out. Nothing
        // owed, so this does not fail the cron.
        case 'unreachable': counts.unreachable += 1; break;
        default: counts.unavailable += 1;
      }
    } catch (error) {
      console.error('[guardian] an undelivered escalation could not be re-attempted', { id: row.id, error });
      counts.unavailable += 1;
      if (options.signal?.aborted) break;
    }
  }
  return counts;
}
