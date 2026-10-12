import { isManager } from '@/lib/constants/roles';

/**
 * Who reads a household member's personal records (the held 0517, the
 * owner's decision): insurance policies, travel documents, voice commands,
 * travel medical information and health providers are read by a parent or
 * adult and by the member a record is about. For the two medical ones a
 * caregiver reads them too: a sitter may need a child's doctor or travel
 * medical detail. A record about nobody is a manager's (and, for the medical
 * ones, a caregiver's).
 *
 * The same rule holds before and after 0517 is released; before it, the
 * database returns more rows, and the screen shows the same ones.
 */
export type PersonalRecordKind = 'personal' | 'medical';

export function readsEveryonesRecords(role: string | null | undefined, kind: PersonalRecordKind = 'personal'): boolean {
  return isManager(role) || (kind === 'medical' && role === 'caregiver');
}

/** The records a viewer reads: all of them, or only the ones about themselves. */
export function recordsInScope<T extends { member_id: string | null }>(
  rows: readonly T[],
  role: string | null | undefined,
  selfMemberId: string | null | undefined,
  kind: PersonalRecordKind = 'personal',
): T[] {
  return readsEveryonesRecords(role, kind) ? [...rows] : rows.filter((r) => r.member_id != null && r.member_id === selfMemberId);
}
