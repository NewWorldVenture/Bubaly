import { isManager } from '@/lib/constants/roles';

/**
 * Who reads a household's care and behaviour notes (the held 0510, the owner's
 * decision "managers, author, caregivers"): a parent or adult and a caregiver
 * read every note; anyone else reads the notes they wrote, and not one written
 * about them by someone else.
 *
 * The same rule holds before and after 0510 is released; before it, the
 * database returns more rows, and the screen shows the same ones.
 */
export function readsEveryNote(role: string | null | undefined): boolean {
  return isManager(role) || role === 'caregiver';
}

/** The notes a viewer reads: all of them, or only the ones they wrote. */
export function notesInScope<T>(
  rows: readonly T[],
  role: string | null | undefined,
  userId: string,
  authorOf: (row: T) => string | null,
): T[] {
  return readsEveryNote(role) ? [...rows] : rows.filter((r) => authorOf(r) === userId);
}
