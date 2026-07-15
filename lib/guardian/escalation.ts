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
