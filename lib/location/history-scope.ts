import { isManager } from '@/lib/constants/roles';

/**
 * Who reads a household's location history, safety check-ins and driving
 * trips (the held 0516, the owner's decision): a parent or adult and a
 * caregiver read everyone's; anyone else reads their own. Live location keeps
 * its own sharing rule (member_locations).
 *
 * The same rule holds before and after 0516 is released; before it, the
 * database returns more rows, and the screen shows the same ones.
 */
export function readsEveryonesHistory(role: string | null | undefined): boolean {
  return isManager(role) || role === 'caregiver';
}

/** The rows a viewer reads: all of them, or only the ones about themselves. */
export function historyInScope<T extends { member_id: string | null }>(
  rows: readonly T[],
  role: string | null | undefined,
  selfMemberId: string | null | undefined,
): T[] {
  return readsEveryonesHistory(role) ? [...rows] : rows.filter((r) => r.member_id != null && r.member_id === selfMemberId);
}
