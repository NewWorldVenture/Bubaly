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
// is `delivered` with the reached managers recorded, which this never touches.
// An attempt that reached somebody but could not update the record leaves its
// claim marked (ESCALATION_SENT_UNRECORDED), and this leaves such a record
// alone rather than reading "nobody reached" and texting everyone again.
//
// When the record itself could not be written — or, on the screening route, the
// escalation could not run at all — a work item was left instead
// (lib/guardian/escalation-owed.ts); each run first lands those records, so
// they are retried like any other.
//
// It is the ONLY retrier of a recorded escalation that reached nobody, and it
// is finite: a record older than the window, an acknowledged one, and one the
// escalation marked `unreachable` (nobody to text or call — no manager phone on
// file, or Twilio not configured — written with notified_member_ids NULL rather
// than empty) are not re-attempted. The inbound lanes complete such messages
// rather than answering 503 for them, because their own retry (the receipt
// drain and Twilio's redelivery) has no deadline.
//
// It runs on the Guardian recovery cron. Its intended cadence is every five
// minutes (scripts/cron-dispatch.mjs); what is GUARANTEED is the daily Vercel
// run (vercel.json), and the GitHub ticks between have been measured hours
// apart. So a retry can land hours after the emergency, and says so (the
// escalation's `originalAt`). Each run is bounded by the deadline the cron
// gives it, and takes the records in turn from where the last run stopped, so
// records that keep failing cannot hold every slot while a newer one waits.
// Landing the owed records takes at most half of the run, so a landing that
// stalls cannot take the records' turn.

import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ESCALATION_SENT_UNRECORDED, escalateGuardianEmergency, type GuardianEscalationOutcome } from './escalate';
import { GUARDIAN_ESCALATION_DESCRIPTION_MAX, guardianEscalationEventId, type GuardianEscalationInput } from './escalation';
import { landOwedGuardianEscalations } from './escalation-owed';

/** How far back a record that reached nobody is still re-attempted. */
export const GUARDIAN_ESCALATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One text plus one call per manager, fanned out together, around a handful of reads and writes. */
const ATTEMPT_MS = 30_000;
/**
 * After an attempt's deadline the escalation stops sending and still writes
 * its record and its claim; this long is allowed for that, inside the run's
 * own deadline, so a cut-off attempt is recorded rather than lost.
 */
const SETTLE_MS = 5_000;
/** An attempt is not started with less than this left of its sending time: one text and one call. */
const MIN_ATTEMPT_MS = 15_000;
/** The run's deadline when the caller gives none. */
const DEFAULT_RUN_MS = 100_000;
/**
 * The most of what is left of the run that landing the owed records may take.
 * Each landing is cut off on its own as well (escalation-owed.ts), so landings
 * that stall — on every run, on the same item — leave the rest of the run to
 * the records already on file.
 */
const OWED_SHARE = 0.5;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const CURSOR_KEY = 'guardian.escalation_retry:cursor:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['emergency_call', 'medical', 'police', 'fire', 'child_safety', 'urgent_personal'] as const;
const SEVERITIES = ['high', 'critical'] as const;
const cursorSchema = z.object({
  version: z.literal(1),
  after: z.object({ escalatedAt: z.string().datetime({ offset: true }), id: z.string().regex(UUID) }).strict(),
}).strict();

export type GuardianEscalationRetryCounts = {
  /** Records re-attempted this run. */
  examined: number;
  /** A manager was reached. */
  delivered: number;
  /**
   * Another worker holds the escalation, it completed between the read and the
   * attempt, or its claim says its alerts went out and only the record update
   * failed — so it is not sent again.
   */
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
  /** Records the run's deadline left unattempted; they are first in line next run. */
  deferred: number;
  /** Records landed from the work item an escalation left when its own record could not be written. */
  recovered: number;
};

export const NO_GUARDIAN_ESCALATION_RETRIES: Readonly<GuardianEscalationRetryCounts> = Object.freeze({
  examined: 0, delivered: 0, duplicate: 0, undelivered: 0, unreachable: 0, unavailable: 0, deferred: 0, recovered: 0,
});

const COLUMNS = 'id, family_id, communication_id, escalation_type, severity, description, caller_number, notified_member_ids, escalated_at';

/** The escalation's input, rebuilt from its own record; null when the record cannot be trusted to rebuild it. */
function inputFrom(row: Record<string, unknown>): GuardianEscalationInput | null {
  const { family_id, communication_id, escalation_type, severity, description, caller_number } = row;
  if (typeof family_id !== 'string' || !UUID.test(family_id)) return null;
  if (communication_id !== null && communication_id !== undefined && (typeof communication_id !== 'string' || !UUID.test(communication_id))) return null;
  if (!TYPES.includes(escalation_type as typeof TYPES[number]) || !SEVERITIES.includes(severity as typeof SEVERITIES[number])) return null;
  if (typeof description !== 'string' || !description.trim() || description.length > GUARDIAN_ESCALATION_DESCRIPTION_MAX) return null;
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

type Position = { escalatedAt: string; id: string };
const positionOf = (row: Record<string, unknown>): Position | null =>
  typeof row.escalated_at === 'string' && typeof row.id === 'string' && UUID.test(row.id) ? { escalatedAt: row.escalated_at, id: row.id } : null;

/** Where the previous run stopped, or null to start from the oldest. A cursor that cannot be read costs fairness for one run, not the run. */
async function readCursor(client: SupabaseClient, signal: AbortSignal): Promise<Position | null> {
  try {
    const { data, error } = await client.from('app_settings').select('key, value').eq('key', CURSOR_KEY).limit(1).abortSignal(signal);
    if (error || !Array.isArray(data)) {
      console.error('[guardian] the escalation retry cursor could not be read; starting from the oldest', { error });
      return null;
    }
    if (!data.length) return null;
    const parsed = cursorSchema.safeParse((data[0] as { value?: unknown }).value);
    return parsed.success ? parsed.data.after : null;
  } catch (error) {
    console.error('[guardian] the escalation retry cursor could not be read; starting from the oldest', { error });
    return null;
  }
}

async function saveCursor(client: SupabaseClient, after: Position, signal: AbortSignal): Promise<void> {
  try {
    const { data, error } = await client.from('app_settings')
      .upsert({ key: CURSOR_KEY, value: { version: 1, after } }, { onConflict: 'key' })
      .select('key')
      .abortSignal(signal);
    // Not saved — refused, or cut off at the run's deadline — the next run
    // starts where this one did: the same records first, which is the
    // unfairness this cursor exists to end — for one run.
    if (error || !Array.isArray(data) || data.length !== 1) console.error('[guardian] the escalation retry cursor could not be saved', { error: error ?? 'no row written' });
  } catch (error) {
    console.error('[guardian] the escalation retry cursor could not be saved', { error });
  }
}

/** One escalation attempt: sends stop at `budgetMs`, and the record and claim get SETTLE_MS more to land. */
async function attempt(client: SupabaseClient, input: GuardianEscalationInput, originalAt: string | undefined, budgetMs: number, parent: AbortSignal | undefined): Promise<GuardianEscalationOutcome> {
  const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(parent ? [parent] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsettled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Guardian escalation retry did not settle')), budgetMs + SETTLE_MS);
  });
  try {
    return await Promise.race([escalateGuardianEmergency(client, input, { signal, ...(originalAt ? { originalAt } : {}) }), unsettled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-attempt recent, unacknowledged escalations whose record says no manager
 * was reached — in turn, from where the last run stopped; bounded in number,
 * per attempt and by the run's `deadline` (epoch ms), after which no attempt
 * is started. Never throws: a ledger that cannot be read is counted as
 * unavailable, so the cron answers non-2xx rather than claiming an empty sweep.
 */
export async function retryUndeliveredGuardianEscalations(
  client: SupabaseClient,
  options: { limit?: number; signal?: AbortSignal; deadline?: number } = {},
): Promise<GuardianEscalationRetryCounts> {
  const counts: GuardianEscalationRetryCounts = { ...NO_GUARDIAN_ESCALATION_RETRIES };
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
  const deadline = options.deadline ?? Date.now() + DEFAULT_RUN_MS;
  const since = new Date(Date.now() - GUARDIAN_ESCALATION_RETRY_WINDOW_MS).toISOString();
  // Every read of the run stops at the run's deadline, and when the caller goes.
  const stop = AbortSignal.any([AbortSignal.timeout(Math.max(0, deadline - Date.now())), ...(options.signal ? [options.signal] : [])]);
  if (stop.aborted) {
    console.error('[guardian] undelivered escalations were not retried: no time was left to read them');
    counts.unavailable += 1;
    return counts;
  }

  const owed = await landOwedGuardianEscalations(client, { since, limit, signal: stop, deadline: Date.now() + Math.max(0, deadline - Date.now()) * OWED_SHARE });
  counts.recovered += owed.landed;
  counts.unavailable += owed.unavailable;

  let rows: Record<string, unknown>[];
  let claims: Map<string, { status: unknown; error: unknown }>;
  try {
    // "Reached nobody" is `sms_sent = false AND call_attempted = false`: a
    // member is recorded as notified only when a text or call to them went
    // through, so the two flags are false exactly when notified_member_ids is
    // empty — and they are plain booleans a filter can ask for. A NULL
    // notified_member_ids is the escalation's own mark for "nobody to text or
    // call" (lib/guardian/escalate.ts, `unreachable`): no phone on file is not
    // mended by trying again, so those are left out here rather than re-run on
    // every recovery tick for a day.
    const read = async (take: number, range?: string): Promise<Record<string, unknown>[]> => {
      let query = client.from('guardian_escalations')
        .select(COLUMNS)
        .is('acknowledged_at', null)
        .eq('sms_sent', false)
        .eq('call_attempted', false)
        .not('notified_member_ids', 'is', null)
        .gte('escalated_at', since);
      if (range) query = query.or(range);
      const { data, error } = await query.order('escalated_at', { ascending: true }).order('id', { ascending: true }).limit(take).abortSignal(stop);
      if (error || !Array.isArray(data)) throw error ?? new Error('Guardian escalations unreadable');
      return data as unknown as Record<string, unknown>[];
    };
    // In turn, not oldest first: records past the previous run's last one,
    // then — wrapping round — the rest from the oldest. Oldest first gave every
    // slot, every run, to the same records when they kept failing (a number
    // Twilio refuses), and a newer emergency behind them waited out its day.
    const after = await readCursor(client, stop);
    if (after) {
      const later = await read(limit, `escalated_at.gt.${after.escalatedAt},and(escalated_at.eq.${after.escalatedAt},id.gt.${after.id})`);
      const wrapped = later.length < limit
        ? await read(limit - later.length, `escalated_at.lt.${after.escalatedAt},and(escalated_at.eq.${after.escalatedAt},id.lte.${after.id})`)
        : [];
      rows = [...later, ...wrapped];
    } else {
      rows = await read(limit);
    }

    // The claims of the records about to be retried: one whose alerts went
    // out while its record could not be updated is not sent again.
    const keyed = rows.map((row) => inputFrom(row)).filter((input): input is GuardianEscalationInput => input !== null).map(guardianEscalationEventId);
    claims = new Map();
    if (keyed.length) {
      const { data, error } = await client.from('guardian_callback_events')
        .select('event_id, status, error').in('event_id', keyed).abortSignal(stop);
      if (error || !Array.isArray(data)) throw error ?? new Error('Guardian escalation claims unreadable');
      for (const claim of data as Array<{ event_id: string; status: unknown; error: unknown }>) claims.set(claim.event_id, claim);
    }
  } catch (error) {
    console.error('[guardian] undelivered escalations could not be read for a retry', { error });
    counts.unavailable += 1;
    return counts;
  }

  let last: Position | null = null;
  for (const [index, row] of rows.entries()) {
    const remaining = deadline - Date.now();
    if (options.signal?.aborted || remaining < MIN_ATTEMPT_MS + SETTLE_MS) {
      // Left for the next run, which starts here (the cursor stops at `last`).
      counts.deferred += rows.length - index;
      break;
    }
    last = positionOf(row) ?? last;
    const notified = row.notified_member_ids;
    if (Array.isArray(notified) && notified.length > 0) continue;
    const input = inputFrom(row);
    if (!input) {
      console.error('[guardian] an undelivered escalation record cannot be re-attempted as written', { id: row.id });
      counts.unavailable += 1;
      continue;
    }
    const claim = claims.get(guardianEscalationEventId(input));
    if (claim?.status === 'error' && claim.error === ESCALATION_SENT_UNRECORDED) {
      // An attempt reached a manager and could not say so on the record, which
      // still reads "nobody reached". Its claim is final (claimGuardianCallback
      // never reclaims it), so an attempt would only find it settled: it is
      // not made, and nobody is texted or called a second time.
      console.error('[guardian] an escalation whose alerts went out is not sent again', { id: row.id });
      counts.duplicate += 1;
      continue;
    }
    counts.examined += 1;
    try {
      const outcome = await attempt(client, input, typeof row.escalated_at === 'string' ? row.escalated_at : undefined, Math.min(ATTEMPT_MS, remaining - SETTLE_MS), options.signal);
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
    }
  }
  // Bounded like every other statement of the run: a stalled save is cut off
  // at the deadline and the counts above are answered, rather than holding the
  // invocation until the platform kills it with none. Every attempt stops
  // sending SETTLE_MS before the deadline, so in the ordinary case the save
  // has most of that.
  if (last) await saveCursor(client, last, stop);
  return counts;
}
