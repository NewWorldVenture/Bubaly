// lib/marketplace/disputes.ts — the dispute state machine + remedy rules (pure,
// unit-tested). Backs marketplace_disputes. The spec is explicit: "do not
// fabricate dispute outcomes" — so this engine ONLY validates status transitions
// and tells you which remedies are applicable to a dispute kind. It never decides
// an outcome; a human (admin) supplies the decision, and this checks it is legal.

export type DisputeKind =
  | 'not_received' | 'damaged' | 'not_as_described' | 'rental_damage' | 'late_return' | 'fraud';

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'rejected' | 'escalated';

export type DisputeRemedy =
  | 'refund_full' | 'refund_partial' | 'deposit_forfeit' | 'late_fee' | 'no_action' | 'escalate';

export const DISPUTE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ['under_review', 'resolved', 'rejected', 'escalated'],
  under_review: ['resolved', 'rejected', 'escalated'],
  escalated: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

export function canDisputeTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return (DISPUTE_TRANSITIONS[from] ?? []).includes(to);
}

export function isDisputeTerminal(status: DisputeStatus): boolean {
  return (DISPUTE_TRANSITIONS[status] ?? []).length === 0;
}

/** Which remedies make sense for each dispute kind (guidance, not a decision). */
const REMEDIES_BY_KIND: Record<DisputeKind, DisputeRemedy[]> = {
  not_received: ['refund_full', 'refund_partial', 'no_action'],
  damaged: ['refund_partial', 'refund_full', 'no_action'],
  not_as_described: ['refund_partial', 'refund_full', 'no_action'],
  rental_damage: ['deposit_forfeit', 'refund_partial', 'no_action'],
  late_return: ['late_fee', 'deposit_forfeit', 'no_action'],
  fraud: ['refund_full', 'escalate', 'no_action'],
};

export function applicableRemedies(kind: DisputeKind): DisputeRemedy[] {
  return REMEDIES_BY_KIND[kind] ?? ['no_action'];
}

export function isValidRemedy(kind: DisputeKind, remedy: DisputeRemedy): boolean {
  return applicableRemedies(kind).includes(remedy);
}

export interface DisputeResolution {
  status: 'resolved' | 'rejected';
  remedy: DisputeRemedy;
}

/**
 * Apply an admin's explicit decision to a dispute. Throws if the transition is
 * illegal, or if the chosen remedy doesn't apply to this dispute kind — so an
 * outcome is always human-supplied and always legal, never fabricated.
 * `no_action` resolves as a rejection (nothing owed).
 */
export function resolveDispute(
  from: DisputeStatus,
  kind: DisputeKind,
  remedy: DisputeRemedy,
): DisputeResolution {
  const target: DisputeResolution['status'] = remedy === 'no_action' ? 'rejected' : 'resolved';
  if (!canDisputeTransition(from, target)) {
    throw new Error(`Cannot move a dispute from "${from}" to "${target}".`);
  }
  if (remedy !== 'escalate' && !isValidRemedy(kind, remedy)) {
    throw new Error(`Remedy "${remedy}" does not apply to a "${kind}" dispute.`);
  }
  return { status: target, remedy };
}
