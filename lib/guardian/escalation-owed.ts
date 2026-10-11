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
//
// It is a second write to a second table, so it does not survive a database
// that refuses everything: an escalation whose record AND work item both fail
// is logged, and only the caller's own retry (the SMS lane's receipt, a
// provider redelivery) can come back for it.

import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { guardianEscalationEventId, guardianEscalationRecordId, guardianEscalationStableId, type GuardianEscalationInput } from './escalation';

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
    description: z.string().min(1).max(4096),
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

/**
 * Whether this escalation has been attempted under this identity before: its
 * record is there, or the work item standing in for a record that did not
 * land. Null when that cannot be read.
 */
export async function guardianEscalationOnFile(client: SupabaseClient, input: GuardianEscalationInput): Promise<boolean | null> {
  try {
    const { data: record, error: recordError } = await client.from('guardian_escalations')
      .select('id').eq('id', guardianEscalationRecordId(input)).eq('family_id', input.familyId).limit(1);
    if (recordError || !Array.isArray(record)) return null;
    if (record.length) return true;
    const { data: owed, error: owedError } = await client.from('ai_tool_calls')
      .select('id').eq('id', guardianEscalationStableId(guardianEscalationEventId(input), 'owed')).eq('family_id', input.familyId)
      .eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL).limit(1);
    if (owedError || !Array.isArray(owed)) return null;
    return owed.length > 0;
  } catch {
    return null;
  }
}

export type OwedLandingCounts = { landed: number; unavailable: number };

/**
 * Land the record every open work item stands for, then close the item. The
 * record says nobody was reached (which is what the escalation would have
 * written), is dated when the escalation was first raised, and is inserted —
 * never upserted — so a record a later attempt DID land, with the managers it
 * reached, is left exactly as it is.
 */
export async function landOwedGuardianEscalations(
  client: SupabaseClient,
  options: { since: string; limit: number; signal: AbortSignal },
): Promise<OwedLandingCounts> {
  const counts: OwedLandingCounts = { landed: 0, unavailable: 0 };
  let items: Array<{ id: string; family_id: string; inputs: unknown; created_at: string }>;
  try {
    const { data, error } = await client.from('ai_tool_calls')
      .select('id, family_id, inputs, created_at')
      .eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL)
      .eq('state', 'reserved')
      .gte('created_at', options.since)
      .order('created_at', { ascending: true })
      .limit(options.limit)
      .abortSignal(options.signal);
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

  for (const item of items) {
    if (options.signal.aborted) break;
    const stored = storedSchema.safeParse(item.inputs);
    if (!stored.success || stored.data.input.familyId !== item.family_id) {
      console.error('[guardian] an owed escalation cannot be landed as written', { id: item.id });
      counts.unavailable += 1;
      continue;
    }
    const { input, pushSent } = stored.data;
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
      }).select('id');
      // A unique violation is the record a later attempt already wrote.
      if (landError && !isUniqueViolation(landError)) {
        console.error('[guardian] an owed escalation record could not be landed', { id: item.id, error: landError });
        counts.unavailable += 1;
        continue;
      }
      if (!landError && (!Array.isArray(landed) || landed.length !== 1)) {
        console.error('[guardian] an owed escalation record could not be confirmed', { id: item.id });
        counts.unavailable += 1;
        continue;
      }
      const { data: closed, error: closeError } = await client.from('ai_tool_calls')
        .update({ state: 'succeeded', attempt: 1, finished_at: new Date().toISOString(), outputs: { version: 1, landed: true } })
        .eq('id', item.id).eq('family_id', item.family_id).eq('tool_name', GUARDIAN_ESCALATION_OWED_TOOL).eq('state', 'reserved')
        .select('id');
      // Left open, the item lands nothing new next time (the record is there),
      // so a failed close costs a read, not a duplicate.
      if (closeError || !Array.isArray(closed) || closed.length !== 1) {
        console.error('[guardian] an owed escalation was landed but could not be closed', { id: item.id, error: closeError ?? 'no row updated' });
      }
      counts.landed += 1;
    } catch (error) {
      console.error('[guardian] an owed escalation record could not be landed', { id: item.id, error });
      counts.unavailable += 1;
    }
  }
  return counts;
}
