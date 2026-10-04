import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { daysInMonth, instantForLocalTime, isValidTimezone, localPartsAt } from '@/lib/time/zoned';

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

type MaintenanceCompletionTask = Pick<
  Tables<'maintenance_tasks'>,
  'id' | 'family_id' | 'status' | 'recurrence' | 'interval_days' | 'due_at' | 'completed_at'
>;

type MaintenanceCompletionDb = Pick<SupabaseClient<Database>, 'from'>;

const CALENDAR_CADENCES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/** True when the task has a supported interval or calendar cadence. */
export function maintenanceRepeats(task: MaintenanceLike): boolean {
  const interval = task.interval_days;
  return (typeof interval === 'number' && Number.isInteger(interval) && interval > 0)
    || (typeof task.recurrence === 'string' && CALENDAR_CADENCES.has(task.recurrence));
}

/**
 * Add calendar days/months in the family's zone, preserving the local due time
 * across daylight-saving changes and regardless of which family member's
 * device completed the task.
 */
function nextAtFamilyTime(anchor: Date, amount: number, unit: 'days' | 'daily' | 'weekly' | 'monthly' | 'yearly', timezone: string): Date | null {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = localPartsAt(anchor, zone);
  const wall = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));

  if (unit === 'days') wall.setUTCDate(wall.getUTCDate() + amount);
  else if (unit === 'daily') wall.setUTCDate(wall.getUTCDate() + 1);
  else if (unit === 'weekly') wall.setUTCDate(wall.getUTCDate() + 7);
  else if (unit === 'monthly') {
    const targetDay = wall.getUTCDate();
    const targetMonth = new Date(Date.UTC(
      wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1, wall.getUTCHours(), wall.getUTCMinutes(),
    ));
    targetMonth.setUTCDate(Math.min(targetDay, daysInMonth(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1)));
    wall.setTime(targetMonth.getTime());
  } else {
    const targetYear = wall.getUTCFullYear() + 1;
    const month = wall.getUTCMonth();
    const targetDay = Math.min(wall.getUTCDate(), daysInMonth(targetYear, month + 1));
    wall.setUTCDate(1);
    wall.setUTCFullYear(targetYear, month, targetDay);
  }

  const next = instantForLocalTime(
    wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(),
    parts.hour * 60 + parts.minute, zone,
  );
  if (!next) return null;
  next.setUTCSeconds(anchor.getUTCSeconds(), anchor.getUTCMilliseconds());
  return next;
}

/**
 * When a repeating task is next due once it is done at `nowIso`.
 *
 * Stepped from the later of its due time and now: done early, the schedule
 * keeps its date; done late, the next occurrence is a full interval after
 * completion. An `interval_days` value wins over a calendar cadence.
 */
export function nextMaintenanceDueAt(task: MaintenanceLike, nowIso: string, timezone = 'UTC'): string | null {
  if (!maintenanceRepeats(task)) return null;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return null;
  const dueMs = task.due_at ? Date.parse(task.due_at) : Number.NaN;
  const anchor = new Date(Number.isFinite(dueMs) && dueMs > nowMs ? dueMs : nowMs);

  let next: Date | null = null;
  if (typeof task.interval_days === 'number' && Number.isInteger(task.interval_days) && task.interval_days > 0) {
    next = nextAtFamilyTime(anchor, task.interval_days, 'days', timezone);
  } else if (task.recurrence && CALENDAR_CADENCES.has(task.recurrence)) {
    next = nextAtFamilyTime(anchor, 1, task.recurrence as 'daily' | 'weekly' | 'monthly' | 'yearly', timezone);
  }
  return next && next.getTime() > nowMs ? next.toISOString() : null;
}

/** A recurring task stays open on its next due time; one-off tasks close. */
export function maintenanceCompletionPatch(task: MaintenanceLike, nowIso: string, timezone = 'UTC'): MaintenanceCompletionPatch {
  const next = nextMaintenanceDueAt(task, nowIso, timezone);
  return next ? { status: 'todo', due_at: next, completed_at: nowIso } : { status: 'done', completed_at: nowIso };
}

/**
 * Save completion only if the family-scoped row still has the schedule that
 * was shown to the user. This compare-and-set keeps a stale browser from
 * overwriting a concurrent cadence edit or a second completion. RLS remains
 * the authority for current membership at the time of the UPDATE.
 */
export async function writeMaintenanceCompletion(
  db: MaintenanceCompletionDb,
  familyId: string,
  task: MaintenanceCompletionTask,
  nowIso: string,
  timezone = 'UTC',
) {
  if (task.family_id !== familyId || (task.status !== 'todo' && task.status !== 'in_progress')) {
    return { data: [], error: null };
  }

  let update = db.from('maintenance_tasks').update(maintenanceCompletionPatch(task, nowIso, timezone))
    .eq('id', task.id)
    .eq('family_id', familyId)
    .eq('status', task.status)
    .eq('recurrence', task.recurrence);
  update = task.interval_days === null
    ? update.is('interval_days', null)
    : update.eq('interval_days', task.interval_days);
  update = task.due_at === null ? update.is('due_at', null) : update.eq('due_at', task.due_at);
  update = task.completed_at === null ? update.is('completed_at', null) : update.eq('completed_at', task.completed_at);
  return update.select('id');
}
