// What "Done" means for a chore assignment on the phone — the same rule the web
// service applies in `completeChoreAssignment` (lib/services/tasks):
//
//   - a chore that needs no approval SETTLES to 'done'; one that needs it waits
//     as 'submitted'. Approval, rejection and the points payout stay manager or
//     server decisions (migration 0223), so the phone never self-approves. This
//     file used to write 'submitted' for every chore and trust "the web's
//     auto-approval engine" — which is the AI-scored photo path only — so a
//     no-approval chore completed from the phone sat in the review queue;
//   - your own assignment, or anyone's as a parent or adult (0374's
//     `chore_assignments_update`: `is_self_member(member_id) or
//     can_manage_family`). The phone used to offer Done on every row and, when
//     RLS filtered a sibling's row to zero, reported "Waiting for approval";
//   - only a chore that is still open. An approved chore is settled for
//     everyone, a manager included: writing it back to 'submitted' hid its
//     points (lib/rewards/points.ts counts points_awarded on approved rows).
//
// Pure — unit-tested from the repo root. The write that carries these rules is
// `completeChore` in queries.ts; a recurring chore settled here is respawned by
// the push-scan cron's `respawnMissingChoreAssignments` sweep.

export type ChoreCompletionPatch = { status: 'done' | 'submitted'; submitted_at: string };

export const OPEN_CHORE_STATUSES = ['todo', 'in_progress'] as const;
/** parent or adult: `can_manage_family` (0374) and the service's `decidesForAnyone`. */
export const MANAGER_ROLES = ['parent', 'adult'] as const;

export function isOpenChore(status: string): boolean {
  return (OPEN_CHORE_STATUSES as readonly string[]).includes(status);
}

export function isManagerRole(role: string | null | undefined): boolean {
  return (MANAGER_ROLES as readonly string[]).includes(role ?? '');
}

/** Whether this person may mark this assignment done — their own, or anyone's as a manager. */
export function mayCompleteChore(row: { member_id: string }, viewer: { memberId: string; role: string }): boolean {
  return row.member_id === viewer.memberId || isManagerRole(viewer.role);
}

/** The settled status the service would write: done when the chore needs no approval, submitted otherwise. */
export function completionPatch(chore: { requires_approval: boolean } | null | undefined, now = new Date()): ChoreCompletionPatch {
  return { status: chore?.requires_approval === false ? 'done' : 'submitted', submitted_at: now.toISOString() };
}

/** Why a completion matched no row — read back after the write, as the service's `refusedCompletion` does. */
export type CompletionRefusal = 'not_yours' | 'approved' | 'gone' | 'changed';

export function explainRefusedCompletion(current: { member_id: string; status: string } | null, viewer: { memberId: string; role: string }): CompletionRefusal {
  if (!current) return 'gone';
  if (current.status === 'approved') return 'approved';
  if (!isManagerRole(viewer.role) && current.member_id !== viewer.memberId) return 'not_yours';
  return 'changed';
}

export const REFUSAL_COPY: Record<CompletionRefusal, string> = {
  not_yours: 'mobileAssistant.choreNotYours',
  approved: 'mobileAssistant.choreApprovedIsSettled',
  gone: 'mobileAssistant.choreGone',
  changed: 'mobileAssistant.choreChanged',
};

export function statusLabel(status: string): string {
  switch (status) {
    case 'todo': return 'To do';
    case 'in_progress': return 'In progress';
    case 'submitted': return 'Waiting for approval';
    case 'done': return 'Done';
    case 'approved': return 'Done';
    case 'rejected': return 'Needs another go';
    default: return status;
  }
}
