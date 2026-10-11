// lib/guardian/escalation-owed.ts — the work item for an emergency escalation
// that reached nobody AND whose record did not land.
//
// The retry sweep (lib/guardian/escalation-retry.ts) re-attempts escalations
// from their guardian_escalations record. When every send failed and that
// record could not be written either, there was nothing for it to find: the
// SMS lane kept its own receipt and retried, but the WhatsApp route parked a
// callback nothing sweeps, and the screening route's after() task only logged.
// The manager text and call were never tried again.
//
// So the escalation leaves this instead: one row in ai_tool_calls (the
// service-role ledger the SMS lane's receipts already live in, family-scoped
// and manager-readable only), keyed on the escalation's own ledger id and
// carrying its input verbatim. The sweep lands the missing record from it — the
// same row, under the same id, that the escalation would have written — and
// closes the item; from then on the record is what the sweep retries, exactly
// as for a record that landed the first time. Nothing here sends anything.
// The screening route leaves the same item when the escalation could not run
// at all (its claim not taken, or a read it needs failed, so it wrote nothing):
// its TwiML has gone out, and nothing else would come back for it.
//
// It is a second write to a second table, so it does not survive a database
// that refuses everything: an escalation whose record AND work item both fail
// is logged, and only the caller's own retry (the SMS lane's receipt, a
// provider redelivery) can come back for it.
//
// The same ledger also holds, further down, the mark a WhatsApp message leaves
// when it is escalated under its text, so that only a later delivery of that
// same message joins that escalation.

import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GUARDIAN_ESCALATION_DESCRIPTION_MAX, guardianEscalationEventId, guardianEscalationRecordId, guardianEscalationStableId, type GuardianEscalationInput } from './escalation';

export const GUARDIAN_ESCALATION_OWED_TOOL = 'guardian.escalation_owed';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// Not guardianEscalationSchema: that one trims, and the hash key of an
// escalation without a communication is computed over the description as
// written, so a trimmed copy would land under a different id.
const storedSchema = z.object({
  version: z.literal(1),
  input: z.object({
    familyId: uuid,
    commId: uuid.optional(),
    escalationType: z.enum(['emergency_call', 'medical', 'police', 'fire', 'child_safety', 'urgent_personal']),
    severity: z.enum(['high', 'critical']),
    description: z.string().min(1).max(GUARDIAN_ESCALATION_DESCRIPTION_MAX),
    callerNumber: z.string().max(64).optional(),
  }).strict(),
  pushSent: z.boolean(),
}).strict();

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === '23505';

/**
 * Leave the work item for an escalation whose record did not land. True when
 * it is on file — written now, or already there from an earlier attempt.
 * Never throws: a failure is logged and answered false.
 */
export async function oweGuardianEscalation(
  client: SupabaseClient,
  input: GuardianEscalationInput,
  details: { pushSent: boolean },
): Promise<boolean> {
  const callbackId = guardianEscalationEventId(input);
  try {
    const { data, error } = await client.from('ai_tool_calls').insert({
      id: guardianEscalationStableId(callbackId, 'owed'),
      family_id: input.familyId,
      tool_name: GUARDIAN_ESCALATION_OWED_TOOL,
      actor_kind: 'system',
      inputs: { version: 1, input, pushSent: details.pushSent },
      outputs: null,
      state: 'reserved',
      attempt: 0,
      idempotency_key: `${GUARDIAN_ESCALATION_OWED_TOOL}:v1:${callbackId}`,
      resource_table: 'guardian_escalations',
      resource_id: guardianEscalationRecordId(input),
    }).select('id');
    if (!error && Array.isArray(data) && data.length === 1) return true;
    if (isUniqueViolation(error)) return true;
    console.error('[guardian] an escalation that reached nobody could not be recorded or left for the retry sweep', { familyId: input.familyId, callbackId, error: error ?? 'no row written' });
    return false;
  } catch (error) {
    console.error('[guardian] an escalation that reached nobody could not be recorded or left for the retry sweep', { familyId: input.familyId, callbackId, error });
    return false;
  }
}

// ── Which escalation a WhatsApp message was given, written down under its sid ──
//
// A WhatsApp emergency is keyed on its communication when the message could be
// recorded, and on its text when it could not (the insert was refused, or its
// answer was lost). A later delivery of the SAME message — Twilio's redelivery
// after the ten-minute reclaim, or a replay of the signed request — usually
// does learn its communication, and switching keys took a new claim and alarmed
// every manager again. That later delivery used to decide "same message" by
// looking for an earlier escalation under the same TEXT, which a different
// message with the same words from the same caller matches too: it was joined
// to the earlier escalation, found settled, and silenced — no text, no call, no
// family notice.
//
// So the delivery that escalates under the text writes that down, keyed on the
// message's sid (the one identity every delivery of a message shares and no
// other message has), with the escalation input verbatim; a later delivery
// joins a text-keyed escalation only when its own sid's mark names one.
// Another message is never joined by this: its sid has no mark.

export const GUARDIAN_WHATSAPP_TEXT_KEY_TOOL = 'guardian.whatsapp_escalation_key';

const textKeyIdempotency = (smsSid: string) => `${GUARDIAN_WHATSAPP_TEXT_KEY_TOOL}:v1:${smsSid}`;

const textKeySchema = z.object({
  version: z.literal(1),
  smsSid: z.string().min(1).max(160),
  input: storedSchema.shape.input,
}).strict();

/**
 * Write down that this WhatsApp message (by its sid) is escalated under its
 * text. True when the mark is on file — written now, or already there. Never
 * throws: a failure is logged and answered false, and the escalation goes out
 * regardless. (Then a later delivery that does learn the communication keys on
 * it, and can alarm a second time: the limit this cannot close while the
 * escalation record does not name the message it came from.)
 */
export async function markGuardianEscalationKeyedOnText(
  client: SupabaseClient,
  smsSid: string,
  input: GuardianEscalationInput,
): Promise<boolean> {
  try {
    const { data, error } = await client.from('ai_tool_calls').insert({
      id: guardianEscalationStableId(`whatsapp:${input.familyId}:${smsSid}`, 'text-key'),
      family_id: input.familyId,
      tool_name: GUARDIAN_WHATSAPP_TEXT_KEY_TOOL,
      actor_kind: 'system',
      inputs: { version: 1, smsSid, input },
      outputs: null,
      // A fact about the message, not work owed: nothing picks it up.
      state: 'succeeded',
      attempt: 1,
      idempotency_key: textKeyIdempotency(smsSid),
      resource_table: 'guardian_escalations',
      resource_id: guardianEscalationRecordId(input),
      finished_at: new Date().toISOString(),
    }).select('id');
    if (!error && Array.isArray(data) && data.length === 1) return true;
    if (isUniqueViolation(error)) return true;
    console.error('[guardian] a WhatsApp escalation keyed on its text could not be written down under its message', { familyId: input.familyId, smsSid, error: error ?? 'no row written' });
    return false;
  } catch (error) {
    console.error('[guardian] a WhatsApp escalation keyed on its text could not be written down under its message', { familyId: input.familyId, smsSid, error });
    return false;
  }
}

export type GuardianTextKeyedEscalation =
  /** An earlier delivery of this message escalated it under its text: this input, verbatim. */
  | { kind: 'text'; input: GuardianEscalationInput }
  /** No delivery of this message has escalated it under its text. */
  | { kind: 'none' }
  /**
   * An earlier delivery did escalate it under its text — the mark is on file —
   * and the mark cannot be parsed as this code writes one (another version's
   * shape, or a description past the bound, as the route used to write it).
   * Not "unreadable": a retry reads the same mark, so giving a claim back for
   * one only answers 503 for ever. The caller keys the escalation on the text,
   * as that delivery did.
   */
  | { kind: 'unparseable' }
  /**
   * The mark could not be read: the query failed. Not "none": the caller
   * chooses no identity from it, and gives its claim back for a retry.
   */
  | { kind: 'unreadable' };

/**
 * Whether an earlier delivery of this WhatsApp message — this family, this sid,
 * nothing else — escalated it under its text, and as what.
 */
export async function guardianEscalationKeyedOnText(client: SupabaseClient, familyId: string, smsSid: string): Promise<GuardianTextKeyedEscalation> {
  let data: unknown;
  try {
    const read = await client.from('ai_tool_calls')
      .select('inputs').eq('family_id', familyId).eq('idempotency_key', textKeyIdempotency(smsSid))
      .eq('tool_name', GUARDIAN_WHATSAPP_TEXT_KEY_TOOL).limit(1);
    if (read.error || !Array.isArray(read.data)) return { kind: 'unreadable' };
    data = read.data;
  } catch {
    return { kind: 'unreadable' };
  }
  const rows = data as Array<{ inputs?: unknown }>;
  if (!rows.length) return { kind: 'none' };
  // Read, and on file. From here nothing is a failed read: a mark that cannot
  // be parsed, or that names another message, family or a communication,
  // stays so however often it is read.
  const mark = textKeySchema.safeParse(rows[0]?.inputs);
  if (!mark.success || mark.data.smsSid !== smsSid || mark.data.input.familyId !== familyId || mark.data.input.commId) return { kind: 'unparseable' };
  return { kind: 'text', input: mark.data.input };
}

export type OwedLandingCounts = {
  landed: number;
  unavailable: number;
  /**
   * Items read and never tried: the phase ended first. Emergencies that
   * reached nobody, with no record on file for the sweep to find, so they are
   * reported as left. Untouched, they keep their count, and so their turn in
   * the next run's order.
   */
  deferred: number;
};

/**
 * How long one item's landing (its record's insert, then its close), or the
 * count of a failed one, may take before it is cut off. Far longer than a
 * one-row insert or update takes, so what is cut here is a statement that is
 * not being answered, and the next item is taken.
 */
const LANDING_MS = 10_000;

type OwedItem = { id: string; family_id: string; inputs: unknown; attempt: unknown; created_at: string };

const triesOf = (item: OwedItem) => (typeof item.attempt === 'number' && Number.isInteger(item.attempt) && item.attempt >= 0 ? item.attempt : 0);

/**
 * Count a landing that failed on its item, so the next run reaches the items
 * tried fewer times first. Logged, never raised. A count is advancement only
 * once it is on file: one refused, matching no row, or cut off leaves the item
 * at the count it had, so it is taken in the same turn next run as in this one.
 */
async function countFailedLanding(client: SupabaseClient, item: OwedItem, signal: AbortSignal): Promise<void> {
  try {
    const { data, error } = await client.from('ai_tool_calls')
      .update({ attempt: triesOf(item) + 1 })
      .eq('id', item.id).eq('family_id', item.family_id).eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL).eq('state', 'reserved')
      .select('id')
      .abortSignal(signal);
    if (error || !Array.isArray(data) || data.length !== 1) console.error('[guardian] an owed escalation that could not be landed could not be counted as tried', { id: item.id, error: error ?? 'no row updated' });
  } catch (error) {
    console.error('[guardian] an owed escalation that could not be landed could not be counted as tried', { id: item.id, error });
  }
}

/**
 * Land the record every open work item stands for, then close the item. The
 * record says nobody was reached (which is what the escalation would have
 * written), is dated when the escalation was first raised, and is inserted —
 * never upserted — so a record a later attempt DID land, with the managers it
 * reached, is left exactly as it is.
 *
 * Least-tried first, then oldest. Oldest first alone gave every slot, every
 * run, to the same items when they could not be landed (one written in a shape
 * this cannot read, or one whose record the database refuses every time), and
 * a newer escalation behind them waited out its window. Each failed landing is
 * counted on its item, so the ones that keep failing take their turn behind the
 * ones not yet tried — once that count is on file. A count refused, matching
 * no row, or cut off is not: the item keeps its count and its turn, and while
 * its counts keep failing the items behind it are taken no sooner. Those the
 * phase does not reach are counted deferred, so the run says so.
 *
 * Bounded, so a stalled statement is cut off inside the run rather than
 * holding it past the function's lifetime, or holding the part of it the work
 * after this phase needs. The read and every landing stop at `deadline` (epoch
 * ms, the end of this phase's share of the run), each landing after
 * LANDING_MS of its own, and everything at `signal` — the run's deadline, or
 * the caller gone. The count of a failed landing may run on past `deadline`
 * (the landing cut off there is one to count), but for LANDING_MS at most, and
 * never past `countBy` (epoch ms, no earlier than `deadline`): the latest this
 * phase holds the run, landings and counts alike. A landing cut off is counted
 * unavailable, never landed; a close cut off leaves the item open, and the
 * next run closes it (its record is on file, for the sweep to retry). The
 * items the phase ends before are counted deferred, and left as they are.
 *
 * A landing cut off short of `countBy` is given its count, too (advancement
 * once on file, as above). It was not, when every landing shared the run's
 * deadline: one whose insert never
 * answered took the whole run on every run, was never counted, and so stayed
 * first — the owed escalations behind it were never landed, and the records
 * on file were never retried after it. Nor did its count have a bound of its
 * own in the phase: bounded by the run's deadline and a fresh LANDING_MS, the
 * count after a landing cut off at `deadline` held the run up to LANDING_MS
 * longer, and a slow drain before it left the records on file under an
 * attempt's time — none was retried, on every run the slowness lasted.
 */
export async function landOwedGuardianEscalations(
  client: SupabaseClient,
  options: { since: string; limit: number; signal: AbortSignal; deadline: number; countBy: number },
): Promise<OwedLandingCounts> {
  const counts: OwedLandingCounts = { landed: 0, unavailable: 0, deferred: 0 };
  // Whole milliseconds: AbortSignal.timeout throws on a fraction, and a share of the run can be one.
  const until = (at: number) => AbortSignal.timeout(Math.max(0, Math.floor(at - Date.now())));
  /** All of this phase, the counts of failed landings included. */
  const counting = AbortSignal.any([options.signal, until(options.countBy)]);
  /** The read, and the landings: this phase's share of the run. */
  const phase = AbortSignal.any([counting, until(options.deadline)]);
  /** A statement of one item: cut off after LANDING_MS, or sooner with `within`. */
  const bounded = (within: AbortSignal) => AbortSignal.any([within, AbortSignal.timeout(LANDING_MS)]);
  let items: OwedItem[];
  try {
    const { data, error } = await client.from('ai_tool_calls')
      .select('id, family_id, inputs, attempt, created_at')
      .eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL)
      .eq('state', 'reserved')
      .gte('created_at', options.since)
      .order('attempt', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(options.limit)
      .abortSignal(phase);
    if (error || !Array.isArray(data)) {
      console.error('[guardian] owed escalations could not be read', { error });
      counts.unavailable += 1;
      return counts;
    }
    items = data as typeof items;
  } catch (error) {
    console.error('[guardian] owed escalations could not be read', { error });
    counts.unavailable += 1;
    return counts;
  }

  /**
   * One that could not be landed — refused, unreadable, or cut off: counted,
   * so it is tried later than the rest once the count is on file. Its count is
   * cut off at `countBy`, as everything in this phase is; past it there is no
   * time left to say so.
   */
  const failed = async (item: OwedItem) => {
    counts.unavailable += 1;
    if (!counting.aborted) await countFailedLanding(client, item, bounded(counting));
  };

  for (const [index, item] of items.entries()) {
    if (phase.aborted) {
      // The phase has ended: inside a landing or a close, or between items.
      // The rest were read and never tried, and are counted, as the records'
      // own loop counts the ones it leaves. Left uncounted, a run that reached
      // none of them answered as though nothing were owed.
      counts.deferred += items.length - index;
      break;
    }
    const stored = storedSchema.safeParse(item.inputs);
    if (!stored.success || stored.data.input.familyId !== item.family_id) {
      console.error('[guardian] an owed escalation cannot be landed as written', { id: item.id });
      await failed(item);
      continue;
    }
    const { input, pushSent } = stored.data;
    const landing = bounded(phase);
    try {
      const { data: landed, error: landError } = await client.from('guardian_escalations').insert({
        id: guardianEscalationRecordId(input),
        family_id: input.familyId,
        communication_id: input.commId ?? null,
        escalation_type: input.escalationType,
        severity: input.severity,
        description: input.description,
        caller_number: input.callerNumber ?? null,
        notified_member_ids: [],
        push_sent: pushSent,
        sms_sent: false,
        call_attempted: false,
        escalated_at: item.created_at,
      }).select('id').abortSignal(landing);
      // A unique violation is the record a later attempt already wrote.
      if (landError && !isUniqueViolation(landError)) {
        console.error('[guardian] an owed escalation record could not be landed', { id: item.id, error: landError });
        await failed(item);
        continue;
      }
      if (!landError && (!Array.isArray(landed) || landed.length !== 1)) {
        console.error('[guardian] an owed escalation record could not be confirmed', { id: item.id });
        await failed(item);
        continue;
      }
      const { data: closed, error: closeError } = await client.from('ai_tool_calls')
        .update({ state: 'succeeded', attempt: triesOf(item) + 1, finished_at: new Date().toISOString(), outputs: { version: 1, landed: true } })
        .eq('id', item.id).eq('family_id', item.family_id).eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL).eq('state', 'reserved')
        .select('id')
        .abortSignal(landing);
      // Left open, the item lands nothing new next time (the record is there),
      // so a failed close — refused, or cut off — costs a read, not a
      // duplicate. The record did land, and is counted so.
      if (closeError || !Array.isArray(closed) || closed.length !== 1) {
        console.error('[guardian] an owed escalation was landed but could not be closed', { id: item.id, error: closeError ?? 'no row updated' });
      }
      counts.landed += 1;
    } catch (error) {
      console.error('[guardian] an owed escalation record could not be landed', { id: item.id, error });
      await failed(item);
    }
  }
  return counts;
}
