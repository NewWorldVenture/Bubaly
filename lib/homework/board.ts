// lib/homework/board.ts — pure helpers for the Homework tracker.
//
// No Supabase / React imports so bucketing, overdue detection, and stats stay
// deterministically unit-testable.

export type HomeworkStatus = 'assigned' | 'in_progress' | 'done' | 'submitted';

export interface HomeworkLike {
  id: string;
  due_at: string | null; // ISO timestamp
  status: HomeworkStatus;
}

/** A piece of homework is "open" when it still needs doing. */
export function isOpen(hw: HomeworkLike): boolean {
  return hw.status === 'assigned' || hw.status === 'in_progress';
}

/** Open homework whose due date is in the past relative to `now`. */
export function isOverdue(hw: HomeworkLike, now: Date): boolean {
  if (!isOpen(hw) || !hw.due_at) return false;
  return new Date(hw.due_at).getTime() < now.getTime();
}

/** Open homework due within `hours` ahead (and not already overdue). */
export function isDueSoon(hw: HomeworkLike, now: Date, hours = 48): boolean {
  if (!isOpen(hw) || !hw.due_at) return false;
  const due = new Date(hw.due_at).getTime();
  const t = now.getTime();
  return due >= t && due <= t + hours * 3600 * 1000;
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'done';

/** Classifies homework into a due-bucket for board grouping. */
export function dueBucket(hw: HomeworkLike, now: Date): DueBucket {
  if (!isOpen(hw)) return 'done';
  if (!hw.due_at) return 'no_date';
  const due = new Date(hw.due_at);
  if (due.getTime() < now.getTime()) return 'overdue';
  const sameDay = due.getFullYear() === now.getFullYear()
    && due.getMonth() === now.getMonth()
    && due.getDate() === now.getDate();
  return sameDay ? 'today' : 'upcoming';
}

/** Groups homework into ordered buckets. Every bucket key is present. */
export function groupByDue<T extends HomeworkLike>(items: T[], now: Date): Record<DueBucket, T[]> {
  const out: Record<DueBucket, T[]> = { overdue: [], today: [], upcoming: [], no_date: [], done: [] };
  for (const hw of items) out[dueBucket(hw, now)].push(hw);
  // Sort dated buckets by due date ascending.
  const byDue = (a: T, b: T) => (a.due_at ?? '').localeCompare(b.due_at ?? '');
  out.overdue.sort(byDue); out.today.sort(byDue); out.upcoming.sort(byDue);
  return out;
}

export interface HomeworkStats {
  open: number;
  overdue: number;
  dueSoon: number;
  completionRate: number; // 0–100 over all items; 0 when empty
}

export function homeworkStats(items: HomeworkLike[], now: Date): HomeworkStats {
  const total = items.length;
  const done = items.filter((h) => !isOpen(h)).length;
  return {
    open: items.filter(isOpen).length,
    overdue: items.filter((h) => isOverdue(h, now)).length,
    dueSoon: items.filter((h) => isDueSoon(h, now)).length,
    completionRate: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

export const HOMEWORK_STATUS_LABELS: Record<HomeworkStatus, string> = {
  assigned: 'Assigned', in_progress: 'In progress', done: 'Done', submitted: 'Submitted',
};
export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming', no_date: 'No due date', done: 'Completed',
};
