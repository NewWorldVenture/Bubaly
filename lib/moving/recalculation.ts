export type MoveDateReviewContext = {
  familyId: string; userId: string; memberId: string | null; role: string | null; active: boolean;
};
export type MoveDateTask = {
  id: string; title: string; status: 'todo' | 'doing' | 'done' | 'skipped';
  mode: 'fixed' | 'relative'; offsetDays: number; dueDate: string | null; nextDueDate: string | null;
  updatedAt: string; action: 'shift' | 'preserve';
  reason: 'relative' | 'completed' | 'skipped' | 'fixed' | 'no_date' | 'out_of_sync';
};
export type MoveDatePreview = {
  version: 1; familyId: string; moveId: string; memberId: string; fromDate: string; toDate: string;
  moveUpdatedAt: string; tasks: MoveDateTask[]; changes: number;
};
export type MoveDateResult = {
  preview: MoveDatePreview; applied: boolean; requestId: string | null; appliedAt: string | null;
};

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

/** Calendar dates, not timestamps or JavaScript's normalized impossible dates. */
export function isMoveDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** UTC calendar arithmetic keeps daylight-saving transitions out of date-only deadlines. */
export function addMoveDays(value: string, days: number): string | null {
  if (!isMoveDate(value) || !Number.isSafeInteger(days) || Math.abs(days) > 365) return null;
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 10);
}

export function moveDateContextKey(context: MoveDateReviewContext): string {
  return JSON.stringify([context.familyId, context.userId, context.memberId, context.role, context.active]);
}

export function isMoveDatePreview(value: unknown): value is MoveDatePreview {
  if (!object(value) || !exactKeys(value, ['version', 'familyId', 'moveId', 'memberId', 'fromDate', 'toDate', 'moveUpdatedAt', 'tasks', 'changes'])
    || value.version !== 1 || !uuid(value.familyId) || !uuid(value.moveId) || !uuid(value.memberId)
    || !isMoveDate(value.fromDate) || !isMoveDate(value.toDate) || value.fromDate === value.toDate
    || !timestamp(value.moveUpdatedAt) || !Array.isArray(value.tasks) || value.tasks.length > 1000
    || !Number.isSafeInteger(value.changes) || Number(value.changes) < 0) return false;
  let priorId = '';
  let changes = 0;
  for (const task of value.tasks) {
    if (!object(task) || !exactKeys(task, ['id', 'title', 'status', 'mode', 'offsetDays', 'dueDate', 'nextDueDate', 'updatedAt', 'action', 'reason'])
      || !uuid(task.id) || task.id <= priorId || typeof task.title !== 'string'
      || !['todo', 'doing', 'done', 'skipped'].includes(String(task.status))
      || !['fixed', 'relative'].includes(String(task.mode))
      || !Number.isSafeInteger(task.offsetDays) || Math.abs(Number(task.offsetDays)) > 365
      || (task.dueDate !== null && !isMoveDate(task.dueDate))
      || (task.nextDueDate !== null && !isMoveDate(task.nextDueDate)) || !timestamp(task.updatedAt)
      || !['relative', 'completed', 'skipped', 'fixed', 'no_date', 'out_of_sync'].includes(String(task.reason))) return false;
    priorId = task.id;
    if (task.action === 'shift') {
      if (task.reason !== 'relative' || task.mode !== 'relative' || !['todo', 'doing'].includes(String(task.status))
        || task.dueDate === null || task.nextDueDate === null
        || task.dueDate !== addMoveDays(value.fromDate, Number(task.offsetDays))
        || task.nextDueDate !== addMoveDays(value.toDate, Number(task.offsetDays))) return false;
      changes += 1;
    } else if (task.action === 'preserve') {
      if (task.nextDueDate !== task.dueDate || task.reason === 'relative'
        || (task.reason === 'skipped' && task.status !== 'skipped')
        || (task.reason === 'fixed' && task.mode !== 'fixed')
        || (task.reason === 'no_date' && task.dueDate !== null)) return false;
    } else return false;
  }
  return changes === value.changes;
}

export function isMoveDateResult(value: unknown): value is MoveDateResult {
  if (!object(value) || !exactKeys(value, ['preview', 'applied', 'requestId', 'appliedAt']) || !isMoveDatePreview(value.preview)) return false;
  return value.applied === true
    ? uuid(value.requestId) && timestamp(value.appliedAt)
    : value.applied === false && value.requestId === null && value.appliedAt === null;
}

export function sameMoveDatePreview(left: MoveDatePreview, right: MoveDatePreview): boolean {
  const canonical = (preview: MoveDatePreview) => JSON.stringify([
    preview.version, preview.familyId, preview.moveId, preview.memberId, preview.fromDate, preview.toDate,
    preview.moveUpdatedAt, preview.changes, preview.tasks.map((task) => [
      task.id, task.title, task.status, task.mode, task.offsetDays, task.dueDate, task.nextDueDate,
      task.updatedAt, task.action, task.reason,
    ]),
  ]);
  return canonical(left) === canonical(right);
}
