import { isManager } from '@/lib/constants/roles';

/**
 * How much of a member's health record a screen shows the person looking (the
 * held 0506, the owner's decision "own record; caregivers too").
 *
 * - `full`: a parent or adult, or the member looking at their own record. The
 *   whole history, and the summaries and coaching built from it.
 * - `authored`: anyone else. Only the entries they logged themselves for that
 *   member, labelled as such, and no summary: a summary built from part of a
 *   record would read as the member's whole record.
 *
 * Who may LOG an entry is a separate question and is not narrowed here: a
 * caregiver still logs a ward's night or meal, and still sees what they logged.
 * The same rule holds before and after 0506 is released; before it, the
 * database returns more rows, and the screen shows the same ones.
 */
export type RecordScope = 'full' | 'authored';

export function recordScope(
  role: string | null | undefined,
  userId: string,
  member: { user_id: string | null } | null | undefined,
): RecordScope {
  if (isManager(role)) return 'full';
  return member?.user_id != null && member.user_id === userId ? 'full' : 'authored';
}

/** The rows about one member that a scope shows: all of them, or only the viewer's own entries. */
export function rowsInScope<T extends { member_id: string | null; created_by: string | null }>(
  rows: readonly T[],
  memberId: string,
  scope: RecordScope,
  userId: string,
): T[] {
  return rows.filter((r) => r.member_id === memberId && (scope === 'full' || r.created_by === userId));
}
