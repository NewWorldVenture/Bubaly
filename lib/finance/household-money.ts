import { isManager } from '@/lib/constants/roles';

/**
 * Who reads a household's money (the held 0514, the owner's decision
 * "parents and adults only"): the accounts and balances, the family wallet,
 * Stripe's account rows, the plan's billing rows and the babysitter payouts
 * are a parent's or adult's. Two exceptions:
 *
 *   * transactions: anyone reads the ones tagged to them (member_id); spending
 *     tagged to nobody is the parents';
 *   * paperwork, home warranties, vehicle registrations and auto insurance:
 *     whoever added a record keeps reading it (created_by).
 *
 * The same rule holds before and after 0514 is released; before it, the
 * database returns more rows, and the screen shows the same ones.
 */
export function readsHouseholdMoney(role: string | null | undefined): boolean {
  return isManager(role);
}

/** The transactions a viewer reads: all of them, or the ones tagged to them. */
export function transactionsInScope<T extends { member_id: string | null }>(
  rows: readonly T[],
  role: string | null | undefined,
  selfMemberId: string | null | undefined,
): T[] {
  return readsHouseholdMoney(role) ? [...rows] : rows.filter((r) => r.member_id != null && r.member_id === selfMemberId);
}

/** The records a viewer reads: all of them, or the ones they added. */
export function addedInScope<T extends { created_by: string | null }>(
  rows: readonly T[],
  role: string | null | undefined,
  userId: string | null | undefined,
): T[] {
  return readsHouseholdMoney(role) ? [...rows] : rows.filter((r) => r.created_by != null && r.created_by === userId);
}

/** Who is reading a record the held 0514 gives a non-manager only when they added it. */
export type MoneyReader = { role: string | null | undefined; userId: string };

/** The user a read is narrowed to (before any limit): null for a parent or adult. */
export function narrowedToAdder(reader: MoneyReader): string | null {
  return readsHouseholdMoney(reader.role) ? null : reader.userId;
}
