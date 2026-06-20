// lib/sync/conflict.ts
//
// Pure conflict detection for the sync engine. Given a local item state and an
// incoming remote state (plus the snapshot we last synced), decide whether the
// two diverged and how. No I/O — fully unit-testable. The engine persists the
// result into sync_conflicts and surfaces it at /dashboard/sync/conflicts.

export type SyncItemState = {
  /** Stable content hash of the item the last time both sides agreed. */
  baseHash?: string | null;
  /** Current content hash on each side. */
  localHash?: string | null;
  remoteHash?: string | null;
  localUpdatedAt?: string | null;
  remoteUpdatedAt?: string | null;
  localDeleted?: boolean;
  remoteDeleted?: boolean;
  /** For reminders/todos: completion can conflict with an edit. */
  localCompleted?: boolean;
  remoteCompleted?: boolean;
};

export type ConflictKind =
  | 'none'
  | 'both_edited'
  | 'deleted_vs_edited'
  | 'time_changed'
  | 'completed_vs_edited';

export type ConflictResult = {
  conflict: boolean;
  kind: ConflictKind;
  /** Suggested resolution when auto-resolve is on; null means "ask the user". */
  suggested: 'keep_local' | 'keep_remote' | 'merge' | null;
  reason: string;
};

const NO_CONFLICT: ConflictResult = {
  conflict: false,
  kind: 'none',
  suggested: null,
  reason: 'No divergence detected.',
};

/**
 * Detect a conflict between local and remote versions of one item.
 *
 * Logic:
 *  - If only one side changed since base, that side wins — no conflict.
 *  - If both sides changed AND now differ from each other -> conflict.
 *  - Delete on one side + edit on the other -> deleted_vs_edited.
 *  - Completion flipped on one side + edit on the other -> completed_vs_edited.
 */
export function detectConflict(s: SyncItemState): ConflictResult {
  const localChanged = s.baseHash != null ? s.localHash !== s.baseHash : s.localHash != null;
  const remoteChanged = s.baseHash != null ? s.remoteHash !== s.baseHash : s.remoteHash != null;

  // Delete vs edit
  if (s.localDeleted && remoteChanged && !s.remoteDeleted) {
    return {
      conflict: true,
      kind: 'deleted_vs_edited',
      suggested: null,
      reason: 'Deleted in theagoras but edited on the provider.',
    };
  }
  if (s.remoteDeleted && localChanged && !s.localDeleted) {
    return {
      conflict: true,
      kind: 'deleted_vs_edited',
      suggested: null,
      reason: 'Deleted on the provider but edited in theagoras.',
    };
  }
  // Both deleted -> converged, no conflict.
  if (s.localDeleted && s.remoteDeleted) return NO_CONFLICT;

  // Completion vs edit (reminders)
  const completionFlipped =
    s.localCompleted !== undefined &&
    s.remoteCompleted !== undefined &&
    s.localCompleted !== s.remoteCompleted;
  if (completionFlipped && localChanged && remoteChanged) {
    return {
      conflict: true,
      kind: 'completed_vs_edited',
      suggested: null,
      reason: 'Completion state and content both diverged.',
    };
  }

  // Both edited and now differ
  if (localChanged && remoteChanged && s.localHash !== s.remoteHash) {
    return {
      conflict: true,
      kind: 'both_edited',
      suggested: chooseByRecency(s),
      reason: 'Edited in both theagoras and the provider since the last sync.',
    };
  }

  return NO_CONFLICT;
}

/** When both edited, prefer the most recently modified side as a *suggestion*. */
function chooseByRecency(s: SyncItemState): 'keep_local' | 'keep_remote' | null {
  if (!s.localUpdatedAt || !s.remoteUpdatedAt) return null;
  const l = new Date(s.localUpdatedAt).getTime();
  const r = new Date(s.remoteUpdatedAt).getTime();
  if (Number.isNaN(l) || Number.isNaN(r) || l === r) return null;
  return l > r ? 'keep_local' : 'keep_remote';
}
