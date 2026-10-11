import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The longest description an escalation carries. The internal route refuses a
 * longer one, and everything that rebuilds an escalation from what was stored
 * takes nothing longer back: the retry sweep from its record, the sweep from a
 * work item, a WhatsApp redelivery from its message's mark.
 */
export const GUARDIAN_ESCALATION_DESCRIPTION_MAX = 4096;

/**
 * An inbound lane's escalation description, cut to what every reader of it
 * takes back. It names the caller, and for a contact that is whatever the
 * family typed (guardian_contacts.name has no bound). Past the bound it was
 * written and then never read again: the sweep could not rebuild the record,
 * the work item could not be landed, and a WhatsApp redelivery could not parse
 * its mark — so an emergency that reached nobody at first was never sent.
 * Cut before the escalation is keyed, so the key a reader rebuilds is the one
 * it was raised under, and never through the middle of a surrogate pair, so
 * what is stored is well-formed text.
 */
export function guardianEscalationDescription(text: string): string {
  if (text.length <= GUARDIAN_ESCALATION_DESCRIPTION_MAX) return text;
  const cut = text.slice(0, GUARDIAN_ESCALATION_DESCRIPTION_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export const guardianEscalationSchema = z.object({
  familyId: z.string().uuid(),
  commId: z.string().uuid().optional(),
  escalationType: z.enum(['emergency_call', 'medical', 'police', 'fire', 'child_safety', 'urgent_personal']),
  severity: z.enum(['high', 'critical']),
  description: z.string().trim().min(1).max(GUARDIAN_ESCALATION_DESCRIPTION_MAX),
  callerNumber: z.string().trim().max(64).optional(),
});

export type GuardianEscalationInput = z.infer<typeof guardianEscalationSchema>;

/** Stable ledger identity for one internal escalation request. */
export function guardianEscalationEventId(input: GuardianEscalationInput): string {
  if (input.commId) return `escalation:communication:${input.commId}`;
  const payload = JSON.stringify([
    input.familyId,
    input.escalationType,
    input.severity,
    input.description,
    input.callerNumber ?? '',
  ]);
  return `escalation:${createHash('sha256').update(payload).digest('hex')}`;
}

/** A stable UUID derived from an escalation's ledger id, so every attempt writes the same rows. */
export function guardianEscalationStableId(callbackId: string, purpose: string): string {
  const hex = createHash('sha256').update(`${callbackId}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The id of the guardian_escalations record an escalation writes. Every
 * attempt at one escalation — the inbound lane's, a redelivery's, the retry
 * sweep's — lands in this row, so asking whether it exists asks whether this
 * escalation has been attempted under this identity before.
 */
export function guardianEscalationRecordId(input: GuardianEscalationInput): string {
  return guardianEscalationStableId(guardianEscalationEventId(input), 'escalation');
}
