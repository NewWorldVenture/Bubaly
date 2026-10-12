import { isManager } from '@/lib/constants/roles';

/**
 * Who reads a household's medications and their schedules (the held 0511, the
 * owner's decision): a parent or adult, a caregiver (who may give them), and
 * the member a medication is for. A medication saved with no member is read
 * by the first two only: the Medicines form defaults "For" to "Whole family",
 * so a parent's own prescription is often stored that way.
 *
 * Doses are not this rule's: 0481 keeps them a manager's or the member's own.
 */
export function readsEveryMedication(role: string | null | undefined): boolean {
  return isManager(role) || role === 'caregiver';
}

/** The members, by family_members.id, who read one medication. */
export function medicationReaderIds(
  roster: readonly { id: string; role: string }[],
  memberId: string | null,
): string[] {
  return roster.filter((m) => readsEveryMedication(m.role) || (memberId != null && m.id === memberId)).map((m) => m.id);
}
