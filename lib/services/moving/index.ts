// Moving: one row per move, a dated task timeline generated from the T-8w →
// T+2w template, and the reviewed date change that shifts it.
//
// WHAT IS REAL HERE. The template lives in `lib/moving/planner.ts` and is the
// same one the Move Planner page runs; `planTasks` below persists what it
// says is missing (matched by `template_key`, so a re-plan never duplicates)
// with `date_mode='relative'`, which is what lets a later date change carry
// the task along. Tasks the assistant adds from live data — one per tracked
// subscription, one per child's school, one per pet's vet — go through
// `addTask` with their own stable `template_key` for the same reason.
//
// WHAT `getMove` READS. Tasks and boxes both, because the burn-down sentence
// counts both — "3 days in · 2/14 boxes unpacked" is only sayable when the
// boxes have actually been read, and the Move Planner page reads the same rows.
//
// WHY `setMoveDate` calls the RPC instead of updating `moves.move_date`:
// migration 0271 guards that column (`moves_reviewed_date_write_guard`) so
// only `move_recalculate_date` may change it, and every relative task's
// `due_date` is checked against `move_date + offset_days` on write. The RPC
// previews, then applies exactly the preview it produced. This service reuses
// `lib/moving/recalculation.ts` to validate both halves, so an unexpected
// shape is a refusal rather than a narrated success. The RPC needs a signed-in
// parent or adult (`auth.uid()`), so a system actor gets an honest "a person
// has to review this" instead of a silent no-op.
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Json, MoveKind, MoveTaskCategory, Tables } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { MOVE_KINDS, TASK_CATEGORIES, moveSummary, planTasks as planFromTemplate, type MoveSummary } from '@/lib/moving/planner';
import { addMoveDays, isMoveDate, isMoveDatePreview, isMoveDateResult, type MoveDatePreview, type MoveDateResult } from '@/lib/moving/recalculation';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { dayKeyInTz, scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type MoveRow = Tables<'moves'>;
export type MoveTaskRow = Tables<'move_tasks'>;
export type MoveBoxRow = Tables<'move_boxes'>;

const MAX_TASKS = 600;
const MAX_BOXES = 600;
const OPEN_STATUSES = ['planning', 'packing', 'moving_day', 'settling'] as const;
const KIND_VALUES = new Set<string>(MOVE_KINDS.map((k) => k.value));
const CATEGORY_VALUES = new Set<string>(TASK_CATEGORIES.map((c) => c.value));
/** The default lead time when a move is put on file without a date. */
const DEFAULT_LEAD_DAYS = 45;

// ── reads ────────────────────────────────────────────────────────────────────

async function readMove(scope: ServiceScope, moveId: string | null): Promise<ServiceResult<MoveRow | null>> {
  let query = scope.db.from('moves').select('*').eq('family_id', scope.familyId);
  query = moveId
    ? query.eq('id', moveId)
    : query.in('status', [...OPEN_STATUSES]).order('move_date', { ascending: true });
  const { data, error } = await query.limit(1);
  if (error) {
    console.error('[service:moving] move read failed', error);
    return fail(describeDbError(error, 'Could not load the move.'), { code: SERVICE_CODES.db });
  }
  return ok(data?.[0] ?? null);
}

async function readTasks(scope: ServiceScope, moveId: string): Promise<ServiceResult<MoveTaskRow[]>> {
  const { data, error } = await scope.db
    .from('move_tasks')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('move_id', moveId)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(MAX_TASKS);
  if (error) {
    console.error('[service:moving] tasks read failed', error);
    return fail(describeDbError(error, 'Could not load the move tasks.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

// The burn-down sentence counts boxes ("4 days in · 3/12 boxes unpacked"), so
// the boxes have to be read before that sentence may be said. A failed read is
// a refusal, not an empty list — an empty list would report "0/0 unpacked" for
// a family whose boxes simply could not be loaded.
async function readBoxes(scope: ServiceScope, moveId: string): Promise<ServiceResult<MoveBoxRow[]>> {
  const { data, error } = await scope.db
    .from('move_boxes')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('move_id', moveId)
    .order('box_number', { ascending: true })
    .limit(MAX_BOXES);
  if (error) {
    console.error('[service:moving] boxes read failed', error);
    return fail(describeDbError(error, 'Could not load the move boxes.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type MoveDetail = { move: MoveRow; tasks: MoveTaskRow[]; boxes: MoveBoxRow[]; summary: MoveSummary };

/**
 * A move with its tasks, its boxes and the burn-down over both. Without an id:
 * the family's soonest open move. `null` data means the family has no move on
 * file — a real answer, distinct from a read that failed. Both the tasks and
 * the boxes are read here because `moveSummary` counts both, and the sentence
 * it produces is what the assistant repeats to the family.
 */
export async function getMove(scope: ServiceScope, input: { moveId?: string | null } = {}): Promise<ServiceResult<MoveDetail | null>> {
  const move = await readMove(scope, input.moveId ?? null);
  if (!move.ok) return move;
  if (!move.data) return ok(null);
  const [tasks, boxes] = await Promise.all([readTasks(scope, move.data.id), readBoxes(scope, move.data.id)]);
  if (!tasks.ok) return tasks;
  if (!boxes.ok) return boxes;
  const today = new Date(`${dayKeyInTz(scopeNow(scope), scope.tz)}T12:00:00`);
  return ok({ move: move.data, tasks: tasks.data, boxes: boxes.data, summary: moveSummary(move.data, tasks.data, boxes.data, today) });
}

// ── create ───────────────────────────────────────────────────────────────────

export type CreateMoveInput = {
  title?: string | null;
  moveDate?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  moveKind?: string | null;
  /** Omit to infer from the roster (any child or teen) and the pets on file. */
  hasKids?: boolean | null;
  hasPets?: boolean | null;
  isRentingOut?: boolean | null;
  notes?: string | null;
};

/** What the household looks like, read live so a template is filtered by facts rather than defaults. */
async function inferHousehold(scope: ServiceScope): Promise<ServiceResult<{ hasKids: boolean; hasPets: boolean }>> {
  const [members, pets] = await Promise.all([
    scope.db.from('family_members').select('id, role').eq('family_id', scope.familyId).eq('is_active', true).in('role', ['child', 'teen']).limit(1),
    scope.db.from('pets').select('id').eq('family_id', scope.familyId).eq('is_active', true).limit(1),
  ]);
  const readError = members.error ?? pets.error;
  if (readError) {
    console.error('[service:moving] household read failed', readError);
    return fail(describeDbError(readError, 'Could not read the household to plan the move.'), { code: SERVICE_CODES.db });
  }
  return ok({ hasKids: (members.data ?? []).length > 0, hasPets: (pets.data ?? []).length > 0 });
}

/**
 * Put a move on file. Returns the family's open move instead of creating a
 * second one when one already exists — a household moves once at a time, and
 * "plan our move" said twice must not produce two timelines.
 */
export async function createMove(scope: ServiceScope, input: CreateMoveInput): Promise<ServiceResult<{ move: MoveRow; created: boolean }>> {
  const existing = await readMove(scope, null);
  if (!existing.ok) return existing;
  if (existing.data) return ok({ move: existing.data, created: false });

  const moveDate = input.moveDate ?? addMoveDays(dayKeyInTz(scopeNow(scope), scope.tz), DEFAULT_LEAD_DAYS);
  if (!moveDate || !isMoveDate(moveDate)) return fail('A move needs a calendar date (YYYY-MM-DD).', { code: SERVICE_CODES.invalidInput });
  const moveKind = (input.moveKind ?? 'local').trim();
  if (!KIND_VALUES.has(moveKind)) return fail(`"${input.moveKind}" is not a move kind Bubaly knows (${[...KIND_VALUES].join(', ')}).`, { code: SERVICE_CODES.invalidInput });

  let hasKids = input.hasKids ?? null;
  let hasPets = input.hasPets ?? null;
  if (hasKids === null || hasPets === null) {
    const inferred = await inferHousehold(scope);
    if (!inferred.ok) return inferred;
    hasKids ??= inferred.data.hasKids;
    hasPets ??= inferred.data.hasPets;
  }

  const { data, error } = await scope.db
    .from('moves')
    .insert({
      family_id: scope.familyId,
      title: input.title?.trim() || 'Our move',
      move_date: moveDate,
      from_address: input.fromAddress?.trim() || null,
      to_address: input.toAddress?.trim() || null,
      move_kind: moveKind as MoveKind,
      has_kids: hasKids,
      has_pets: hasPets,
      is_renting_out: input.isRentingOut ?? false,
      notes: input.notes?.trim() || null,
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:moving] move insert failed', error);
    return fail(describeDbError(error, 'Could not put the move on file.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'moving', action: 'create', title: `Put "${data.title}" on file for ${data.move_date}`, href: '/dashboard/moving', resourceId: data.id });
  return ok({ move: data, created: true });
}

// ── plan ─────────────────────────────────────────────────────────────────────

export type PlannedTasks = { move: MoveRow; inserted: MoveTaskRow[]; alreadyPlanned: number };

/**
 * Generate the template tasks this move is still missing. Matched by
 * `template_key`, so running it again inserts nothing; every row is
 * `relative` to move day so a date change carries it.
 */
export async function planTasks(scope: ServiceScope, input: { moveId?: string | null } = {}): Promise<ServiceResult<PlannedTasks>> {
  const move = await readMove(scope, input.moveId ?? null);
  if (!move.ok) return move;
  if (!move.data) return fail('There is no move on file yet.', { code: SERVICE_CODES.notFound });
  const existing = await readTasks(scope, move.data.id);
  if (!existing.ok) return existing;

  const planned = planFromTemplate(move.data, existing.data);
  const alreadyPlanned = existing.data.filter((t) => t.template_key).length;
  if (planned.length === 0) return ok({ move: move.data, inserted: [], alreadyPlanned });

  const { data, error } = await scope.db
    .from('move_tasks')
    .insert(planned.map((task) => ({
      family_id: scope.familyId,
      move_id: move.data!.id,
      title: task.title,
      category: task.category,
      offset_days: task.offsetDays,
      // The trigger in 0271 checks a relative task's date against move_date + offset;
      // this is that arithmetic, in UTC, so DST can never make the two disagree.
      due_date: addMoveDays(move.data!.move_date, task.offsetDays),
      date_mode: 'relative' as const,
      template_key: task.key,
      created_by: scope.userId,
    })))
    .select('*');
  if (error) {
    console.error('[service:moving] task insert failed', error);
    return fail(describeDbError(error, 'Could not add the move tasks.'), { code: SERVICE_CODES.db });
  }
  const inserted = data ?? [];
  await recordActivitySafely(scope, { agent: 'moving', action: 'create', title: `Added ${inserted.length} move task${inserted.length === 1 ? '' : 's'} to "${move.data.title}"`, href: '/dashboard/moving', resourceId: move.data.id });
  return ok({ move: move.data, inserted, alreadyPlanned });
}

// ── add one task ─────────────────────────────────────────────────────────────

export type AddTaskInput = {
  moveId?: string | null;
  title: string;
  category?: string | null;
  /** Days relative to move day; with it the task follows a date change. */
  offsetDays?: number | null;
  /** A fixed calendar date instead; ignored when `offsetDays` is given. */
  dueDate?: string | null;
  assigneeId?: string | null;
  /** A stable key so the same task is never added twice (address-sub-<id>, school-<member>…). */
  templateKey?: string | null;
  notes?: string | null;
};

/**
 * Add one task to the move. With a `templateKey` that already exists on the
 * move, the existing row comes back and nothing is written — that is how the
 * assistant's per-subscription address tasks stay idempotent across re-plans.
 */
export async function addTask(scope: ServiceScope, input: AddTaskInput): Promise<ServiceResult<{ task: MoveTaskRow; created: boolean }>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A move task needs a title.', { code: SERVICE_CODES.invalidInput });
  const category = (input.category ?? 'other').trim();
  if (!CATEGORY_VALUES.has(category)) return fail(`"${input.category}" is not a move task category (${[...CATEGORY_VALUES].join(', ')}).`, { code: SERVICE_CODES.invalidInput });
  if (input.offsetDays != null && (!Number.isInteger(input.offsetDays) || Math.abs(input.offsetDays) > 365)) {
    return fail('A task offset is a whole number of days within a year of move day.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.offsetDays == null && input.dueDate && !isMoveDate(input.dueDate)) {
    return fail('A due date is a calendar date (YYYY-MM-DD).', { code: SERVICE_CODES.invalidInput });
  }

  const move = await readMove(scope, input.moveId ?? null);
  if (!move.ok) return move;
  if (!move.data) return fail('There is no move on file yet.', { code: SERVICE_CODES.notFound });

  const templateKey = input.templateKey?.trim() || null;
  if (templateKey) {
    const { data, error } = await scope.db
      .from('move_tasks')
      .select('*')
      .eq('family_id', scope.familyId)
      .eq('move_id', move.data.id)
      .eq('template_key', templateKey)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[service:moving] task lookup failed', error);
      return fail(describeDbError(error, 'Could not check the move tasks.'), { code: SERVICE_CODES.db });
    }
    if (data) return ok({ task: data, created: false });
  }

  const relative = input.offsetDays != null;
  const dueDate = relative ? addMoveDays(move.data.move_date, input.offsetDays as number) : (input.dueDate ?? null);
  if (relative && !dueDate) return fail('That offset puts the task outside the calendar.', { code: SERVICE_CODES.invalidInput });

  const { data, error } = await scope.db
    .from('move_tasks')
    .insert({
      family_id: scope.familyId,
      move_id: move.data.id,
      title,
      category: category as MoveTaskCategory,
      offset_days: relative ? (input.offsetDays as number) : 0,
      due_date: dueDate,
      date_mode: relative ? 'relative' : 'fixed',
      assignee_id: input.assigneeId ?? null,
      template_key: templateKey,
      notes: input.notes?.trim() || null,
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:moving] task insert failed', error);
    return fail(describeDbError(error, 'Could not add the move task.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'moving', action: 'create', title: `Added "${title}" to the move`, href: '/dashboard/moving', memberId: input.assigneeId ?? null, resourceId: data.id });
  return ok({ task: data, created: true });
}

// ── set the date ─────────────────────────────────────────────────────────────

export type MoveDateChange = {
  move: MoveRow;
  fromDate: string;
  toDate: string;
  /** Tasks whose due date moved with the day. */
  shifted: number;
  /** Tasks left where they were: done, skipped, fixed-date, undated or out of sync. */
  preserved: number;
  preview: MoveDatePreview;
  result: MoveDateResult;
};

function rpcMessage(error: { code?: string; message?: string } | null): string {
  switch (error?.code) {
    case '42501': return 'A signed-in parent or adult has to change the move date.';
    case '40001': return 'The move changed while the new date was being reviewed. Try again.';
    case 'P0002': return 'That move is not on file for this family.';
    case '22023': return error.message === 'same_move_date' ? 'The move is already on that date.' : error.message === 'move_closed' ? 'That move is finished; its date cannot change.' : 'That move-date change cannot be applied.';
    case '54000': return 'There are too many tasks to safely review this move.';
    default: return describeDbError(error, 'Could not change the move date.');
  }
}

/**
 * Move the move: preview the shift through `move_recalculate_date`, validate
 * the preview with the same rules the page uses, then apply exactly that
 * preview. Relative, still-open tasks shift with the day; everything else
 * keeps its date and is reported as preserved.
 */
export async function setMoveDate(scope: ServiceScope, input: { moveId?: string | null; date: string }): Promise<ServiceResult<MoveDateChange>> {
  if (!isMoveDate(input.date)) return fail('A move date is a calendar date (YYYY-MM-DD).', { code: SERVICE_CODES.invalidInput });
  if (!scope.memberId || !scope.userId || (scope.role !== 'system' && !isManager(scope.role))) {
    return fail('A signed-in parent or adult has to change the move date.', { code: SERVICE_CODES.denied });
  }
  const move = await readMove(scope, input.moveId ?? null);
  if (!move.ok) return move;
  if (!move.data) return fail('There is no move on file yet.', { code: SERVICE_CODES.notFound });
  if (move.data.move_date === input.date) return fail('The move is already on that date.', { code: SERVICE_CODES.invalidInput });

  const args = { p_family_id: scope.familyId, p_move_id: move.data.id, p_member_id: scope.memberId, p_new_date: input.date };
  const previewed = await scope.db.rpc('move_recalculate_date', { ...args, p_expected: null, p_request_id: null });
  if (previewed.error) {
    console.error('[service:moving] move date preview failed', previewed.error);
    return fail(rpcMessage(previewed.error), { code: SERVICE_CODES.db });
  }
  if (!isMoveDateResult(previewed.data) || previewed.data.applied || previewed.data.preview.moveId !== move.data.id || previewed.data.preview.toDate !== input.date) {
    console.error('[service:moving] move date preview had an unexpected shape');
    return fail('The move-date review could not be confirmed.', { code: SERVICE_CODES.db });
  }
  const preview = previewed.data.preview;
  if (!isMoveDatePreview(preview)) return fail('The move-date review could not be confirmed.', { code: SERVICE_CODES.db });

  const applied = await scope.db.rpc('move_recalculate_date', { ...args, p_expected: preview as unknown as Json, p_request_id: randomUUID() });
  if (applied.error) {
    console.error('[service:moving] move date apply failed', applied.error);
    return fail(rpcMessage(applied.error), { code: SERVICE_CODES.db });
  }
  if (!isMoveDateResult(applied.data) || !applied.data.applied || applied.data.preview.toDate !== input.date) {
    console.error('[service:moving] move date apply had an unexpected shape');
    return fail('The move-date change could not be confirmed.', { code: SERVICE_CODES.db });
  }

  const shifted = applied.data.preview.tasks.filter((t) => t.action === 'shift').length;
  const preserved = applied.data.preview.tasks.length - shifted;
  await recordActivitySafely(scope, { agent: 'moving', action: 'update', title: `Moved "${move.data.title}" to ${input.date}${shifted ? ` and shifted ${shifted} task${shifted === 1 ? '' : 's'}` : ''}`, href: '/dashboard/moving', resourceId: move.data.id });
  return ok({
    move: { ...move.data, move_date: input.date },
    fromDate: preview.fromDate,
    toDate: input.date,
    shifted,
    preserved,
    preview,
    result: applied.data,
  });
}

// ── what a plan reads from live data ─────────────────────────────────────────

export type MoveContextSources = {
  subscriptions: { id: string; name: string }[];
  bills: { id: string; name: string; category: string | null }[];
  schoolClasses: { memberId: string; schoolName: string | null }[];
  pets: { id: string; name: string; vetName: string | null }[];
};

const MAX_SOURCE_ROWS = 25;

/**
 * The live rows a move plan personalises from: every tracked subscription and
 * recurring bill that needs a new address, each child with a school on the
 * timetable, each pet with a vet. Names only — no amounts, no phone numbers.
 */
export async function listMoveSources(scope: ServiceScope): Promise<ServiceResult<MoveContextSources>> {
  const [subs, bills, classes, pets] = await Promise.all([
    scope.db.from('subscriptions_tracked').select('id, name, status').eq('family_id', scope.familyId).order('name').limit(MAX_SOURCE_ROWS * 2),
    scope.db.from('bills').select('id, name, category, is_recurring').eq('family_id', scope.familyId).eq('is_recurring', true).order('name').limit(MAX_SOURCE_ROWS * 2),
    scope.db.from('school_classes').select('member_id, school_name').eq('family_id', scope.familyId).limit(200),
    scope.db.from('pets').select('id, name, vet_name').eq('family_id', scope.familyId).eq('is_active', true).order('name').limit(MAX_SOURCE_ROWS),
  ]);
  const readError = subs.error ?? bills.error ?? classes.error ?? pets.error;
  if (readError) {
    console.error('[service:moving] move sources read failed', readError);
    return fail(describeDbError(readError, 'Could not read what the move needs to update.'), { code: SERVICE_CODES.db });
  }
  const byMember = new Map<string, string | null>();
  for (const row of classes.data ?? []) {
    if (!byMember.has(row.member_id) || (!byMember.get(row.member_id) && row.school_name)) byMember.set(row.member_id, row.school_name ?? null);
  }
  return ok({
    subscriptions: (subs.data ?? []).filter((s) => s.status !== 'canceled').slice(0, MAX_SOURCE_ROWS).map((s) => ({ id: s.id, name: s.name })),
    bills: (bills.data ?? []).slice(0, MAX_SOURCE_ROWS).map((b) => ({ id: b.id, name: b.name, category: b.category })),
    schoolClasses: [...byMember.entries()].map(([memberId, schoolName]) => ({ memberId, schoolName })),
    pets: (pets.data ?? []).map((p) => ({ id: p.id, name: p.name, vetName: p.vet_name })),
  });
}
