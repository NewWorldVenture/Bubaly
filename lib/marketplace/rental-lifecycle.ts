// lib/marketplace/rental-lifecycle.ts — the rental/borrow transaction state
// machine + deposit settlement (pure, unit-tested). Encodes the spec's statuses
// (requested → approved → active → picked_up → returned/late/damaged →
// completed, with declined/disputed branches) and the hard rule "never release
// deposits without the configured workflow": a deposit can only be settled once
// the item has actually come back (or a dispute concludes). Also computes late
// fees and damage deductions. Backs marketplace_rentals / _borrowing_agreements /
// _deposits.

export type RentalStatus =
  | 'requested' | 'approved' | 'declined' | 'active' | 'picked_up'
  | 'returned' | 'late' | 'damaged' | 'completed' | 'disputed';

/** Allowed next statuses from each status. Terminal states map to []. */
export const RENTAL_TRANSITIONS: Record<RentalStatus, RentalStatus[]> = {
  requested: ['approved', 'declined'],
  approved: ['active', 'declined', 'disputed'],
  active: ['picked_up', 'disputed'],
  picked_up: ['returned', 'late', 'damaged', 'disputed'],
  returned: ['completed', 'damaged', 'disputed'],
  late: ['returned', 'damaged', 'disputed'],
  damaged: ['completed', 'disputed'],
  disputed: ['completed', 'declined'],
  declined: [],
  completed: [],
};

export function nextStatuses(from: RentalStatus): RentalStatus[] {
  return RENTAL_TRANSITIONS[from] ?? [];
}

export function canTransition(from: RentalStatus, to: RentalStatus): boolean {
  return nextStatuses(from).includes(to);
}

export function isTerminal(status: RentalStatus): boolean {
  return nextStatuses(status).length === 0;
}

// ── Deposit settlement ─────────────────────────────────────────────────────

/** The item has been accounted for → a deposit may be settled from these states. */
const DEPOSIT_SETTLEABLE: ReadonlySet<RentalStatus> = new Set(['returned', 'late', 'damaged', 'completed']);

/** True only when the workflow has reached a point where a deposit can be released. */
export function canSettleDeposit(status: RentalStatus): boolean {
  return DEPOSIT_SETTLEABLE.has(status);
}

export type ReturnCondition = 'as_sent' | 'minor_wear' | 'damaged' | 'lost';

export interface DepositSettlement {
  releaseCents: number;   // returned to the renter/borrower
  forfeitCents: number;   // kept by the owner
  status: 'released' | 'partially_released' | 'forfeited';
}

/**
 * Settle a security deposit AFTER the return workflow. Throws if called before
 * the item is accounted for — enforcing "never release deposits without the
 * configured workflow". Damage forfeits up to the assessed damage (capped at the
 * deposit); a lost item forfeits the whole deposit.
 */
export function settleDeposit(
  rentalStatus: RentalStatus,
  depositCents: number,
  condition: ReturnCondition,
  damageCents = 0,
): DepositSettlement {
  if (!canSettleDeposit(rentalStatus)) {
    throw new Error(`Cannot settle a deposit while the rental is "${rentalStatus}" — complete the return workflow first.`);
  }
  const deposit = Math.max(0, Math.round(depositCents));
  let forfeit = 0;
  switch (condition) {
    case 'as_sent':
    case 'minor_wear':
      forfeit = 0;
      break;
    case 'damaged':
      forfeit = Math.min(deposit, Math.max(0, Math.round(damageCents)));
      break;
    case 'lost':
      forfeit = deposit;
      break;
  }
  const release = deposit - forfeit;
  const status: DepositSettlement['status'] = forfeit === 0 ? 'released' : forfeit >= deposit ? 'forfeited' : 'partially_released';
  return { releaseCents: release, forfeitCents: forfeit, status };
}

// ── Late fees ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Whole days a return is late (0 if on time or missing dates). */
export function daysLate(dueAt: string | Date | null | undefined, returnedAt: string | Date | null | undefined): number {
  if (!dueAt || !returnedAt) return 0;
  const due = new Date(dueAt).getTime();
  const ret = new Date(returnedAt).getTime();
  if (Number.isNaN(due) || Number.isNaN(ret) || ret <= due) return 0;
  return Math.ceil((ret - due) / DAY_MS);
}

/** Late fee in cents = whole days late × the configured daily late fee. */
export function lateFeeCents(
  dueAt: string | Date | null | undefined,
  returnedAt: string | Date | null | undefined,
  dailyLateFeeCents: number,
): number {
  const days = daysLate(dueAt, returnedAt);
  return days * Math.max(0, Math.round(dailyLateFeeCents));
}
