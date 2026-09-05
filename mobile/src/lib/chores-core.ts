// What "Done" means for a chore assignment — the same rule as the web app:
// a member can only SUBMIT their chore (`status: 'submitted'`). Approval,
// rejection and the points/wallet payout are manager or server decisions
// (DB-guarded by migration 0223), so the app never self-approves — even for
// chores that don't require review, the web's auto-approval engine decides.
// Pure — unit-tested from the repo root.

export type ChoreCompletionPatch = { status: 'submitted'; submitted_at: string };

export const OPEN_CHORE_STATUSES = ['todo', 'in_progress'] as const;

export function isOpenChore(status: string): boolean {
  return (OPEN_CHORE_STATUSES as readonly string[]).includes(status);
}

export function completionPatch(now = new Date()): ChoreCompletionPatch {
  return { status: 'submitted', submitted_at: now.toISOString() };
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'todo': return 'To do';
    case 'in_progress': return 'In progress';
    case 'submitted': return 'Waiting for approval';
    case 'approved': return 'Done';
    case 'rejected': return 'Needs another go';
    default: return status;
  }
}
