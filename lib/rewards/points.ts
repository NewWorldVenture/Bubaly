// lib/rewards/points.ts — pure helpers for the Rewards & Allowance center.
//
// Points are earned from approved chore assignments and spent on approved /
// fulfilled reward redemptions. No Supabase / React here so the ledger math is
// deterministically unit-testable.

export type RedemptionStatus = 'requested' | 'approved' | 'fulfilled' | 'rejected';

export interface AssignmentLike {
  member_id: string;
  status: string;             // task_status
  points_awarded: number | null;
}

export interface RedemptionLike {
  member_id: string;
  cost_points: number;
  status: RedemptionStatus;
}

/** Statuses where a redemption's cost counts against a member's balance. */
const SPENDING_STATUSES = new Set<RedemptionStatus>(['approved', 'fulfilled']);

/** Sum of points a member has earned from approved chore assignments. */
export function earnedByMember(assignments: AssignmentLike[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of assignments) {
    // Only approved chores with an awarded amount contribute.
    if (a.status !== 'approved' || a.points_awarded == null) continue;
    map.set(a.member_id, (map.get(a.member_id) ?? 0) + a.points_awarded);
  }
  return map;
}

/** Sum of points a member has committed via approved/fulfilled redemptions. */
export function spentByMember(redemptions: RedemptionLike[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of redemptions) {
    if (!SPENDING_STATUSES.has(r.status)) continue;
    map.set(r.member_id, (map.get(r.member_id) ?? 0) + r.cost_points);
  }
  return map;
}

export interface MemberBalance {
  memberId: string;
  earned: number;
  spent: number;
  available: number;
}

/**
 * Computes earned / spent / available points for each member id provided.
 * Available is clamped at 0 (a member can never show a negative balance).
 */
export function computeBalances(
  memberIds: string[],
  assignments: AssignmentLike[],
  redemptions: RedemptionLike[],
): MemberBalance[] {
  const earned = earnedByMember(assignments);
  const spent = spentByMember(redemptions);
  return memberIds.map((memberId) => {
    const e = earned.get(memberId) ?? 0;
    const s = spent.get(memberId) ?? 0;
    return { memberId, earned: e, spent: s, available: Math.max(0, e - s) };
  });
}

/** Whether a member can afford a reward at `cost`. */
export function canAfford(balance: MemberBalance | undefined, cost: number): boolean {
  return !!balance && balance.available >= cost;
}

export const REDEMPTION_STATUS_LABELS: Record<RedemptionStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  fulfilled: 'Fulfilled',
  rejected: 'Rejected',
};
