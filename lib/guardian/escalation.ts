import { createHash } from 'node:crypto';
import { z } from 'zod';

export const guardianEscalationSchema = z.object({
  familyId: z.string().uuid(),
  commId: z.string().uuid().optional(),
  escalationType: z.enum(['emergency_call', 'medical', 'police', 'fire', 'child_safety', 'urgent_personal']),
  severity: z.enum(['high', 'critical']),
  description: z.string().trim().min(1).max(4096),
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
