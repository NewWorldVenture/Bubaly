// lib/home/maintenance-rollover.ts — what completing a maintenance task writes.
// Pure and clock-free (the caller passes `now`), so the decision is unit-testable.
import { nextRemindAt } from '@/lib/reminders/details';

export type MaintenanceLike = {
  due_at: string | null;
  /** "Every N days" — set by the Home service and the assistant's home tool. */
  interval_days: number | null;
  /** A calendar cadence ('none' | 'daily' | 'weekly' | 'monthly' | 'yearly'). */
  recurrence?: string | null;
};

export type MaintenanceCompletionPatch =
  | { status: 'done'; completed_at: string }
  | { status: 'todo'; due_at: string; completed_at: string };

const DAY_MS = 86_400_000;

/** True when the task repeats: an `interval_days` ("every 90 days") or a calendar cadence. */
export function maintenanceRepeats(task: MaintenanceLike): boolean {
  if (typeof task.interval_days === 'number' && Number.isFinite(task.interval_days) && task.interval_days > 0) return true;
  return !!task.recurrence && task.recurrence !== 'none';
}

/**
 * When a repeating task is next due once it is done at `nowIso`.
 *
 * Stepped from the LATER of its due time and now: done early, the schedule
 * keeps its date (the filter due on the 10th and changed on the 3rd is next
 * due 90 days after the 10th); done late, the next one is a full interval
 * after the day it was actually done, not after a date already missed. An
 * `interval_days` wins over a calendar cadence when both are set. Null when
 * the task does not repeat, or its cadence is one nothing can step.
 */
export function nextMaintenanceDueAt(task: MaintenanceLike, nowIso: string): string | null {
  if (!maintenanceRepeats(task)) return null;
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return null;
  const due = task.due_at ? Date.parse(task.due_at) : Number.NaN;
  const anchor = Number.isNaN(due) || due < now ? now : due;
  if (typeof task.interval_days === 'number' && task.interval_days > 0) {
    return new Date(anchor + task.interval_days * DAY_MS).toISOString();
  }
  const next = nextRemindAt(new Date(anchor).toISOString(), task.recurrence ?? 'none');
  return next && Date.parse(next) > now ? next : null;
}

/**
 * What "complete" writes.
 *
 * A repeating task ("every 90 days", a yearly service) is ONE row. Marked
 * `done`, it left the open list for good — the Home module, the brief, the
 * operating index and the insights all read `status in ('todo',
 * 'in_progress')` — so a smoke-alarm check set to repeat every 180 days was
 * done once and never asked for again. It now stays open on its next due
 * time, and `completed_at` records when it was last done. A task that does
 * not repeat is done, as before.
 */
export function maintenanceCompletionPatch(task: MaintenanceLike, nowIso: string): MaintenanceCompletionPatch {
  const next = nextMaintenanceDueAt(task, nowIso);
  return next ? { status: 'todo', due_at: next, completed_at: nowIso } : { status: 'done', completed_at: nowIso };
}
