// Routines: a family's "every Sunday, plan our meals" (§19, §58).
//
// THE RULE THIS FILE KEEPS: a routine files a REQUEST. It never executes
// anything itself. Whatever the family scheduled goes through the same intake,
// the same planner, the same trust gate and the same `family_ai_settings` as a
// request typed by hand — so a schedule is permission to ASK on a cadence,
// never permission to act unreviewed. There is exactly one execution path in
// this product and a routine does not get a second one.
//
// The fire guard is a row, not a lock: `routine_runs` is unique on (rule,
// due_at), so reserving the occurrence IS the claim. A worker that dies after
// reserving leaves a row that says the occurrence was handled — which is the
// safe direction to fail, because the alternative is telling a family the same
// thing twice.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';
import { ROUTINE_ANCHORS, anchorByKey } from './anchors';
import { nextCronRun, nextRelativeRun, parseSchedule, type RelativeSchedule, type Schedule } from './schedule';

type DB = SupabaseClient<Database>;
type RuleRow = Database['public']['Tables']['family_automation_rules']['Row'];

export type Routine = {
  id: string;
  name: string;
  said: string | null;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  schedule: { kind: 'cron'; expr: string } | { kind: 'relative'; anchorKey: string; offsetDays: number; atHour: number } | null;
};

/** The rule columns a schedule needs; anything else on the row is another feature's. */
function toRoutine(row: RuleRow): Routine {
  const config = (row.action_config ?? {}) as { prompt?: unknown };
  return {
    id: row.id,
    name: row.name,
    said: row.said,
    prompt: typeof config.prompt === 'string' ? config.prompt : row.name,
    enabled: row.is_enabled,
    nextRunAt: row.next_run_at,
    schedule: row.schedule_kind === 'cron' && row.schedule_expr
      ? { kind: 'cron', expr: row.schedule_expr }
      : row.schedule_kind === 'relative' && row.anchor_key && row.offset_days !== null
        ? { kind: 'relative', anchorKey: row.anchor_key, offsetDays: row.offset_days, atHour: row.at_hour ?? 9 }
        : null,
  };
}

export type CreateRoutineInput = {
  /** What the family typed, e.g. "every Sunday plan our meals". */
  said: string;
  /** What Bubaly should do when it fires — the request text. */
  prompt: string;
  name?: string;
};

/**
 * Create a routine from what a family said.
 *
 * A schedule this parser cannot read is refused rather than guessed: the
 * caller (the `routines.create` tool) then asks when they meant, which is the
 * only honest way to end up with a routine that fires when they expect.
 */
export async function createRoutine(scope: ServiceScope, input: CreateRoutineInput, opts?: { db?: DB }): Promise<ServiceResult<Routine>> {
  if (!isManager(scope.role)) {
    return fail('Only a parent or adult can set up a routine.', { code: SERVICE_CODES.denied });
  }
  const prompt = input.prompt?.trim();
  if (!prompt) return fail('Say what Bubaly should do when the routine runs.', { code: SERVICE_CODES.invalidInput });

  const schedule = parseSchedule(input.said ?? '', ROUTINE_ANCHORS);
  if (!schedule) {
    return fail('Bubaly could not tell when to run that. Try "every Sunday at 5pm" or "two days before every trip".', { code: SERVICE_CODES.invalidInput });
  }

  const now = scope.now ?? new Date();
  const db = opts?.db ?? scope.db;
  // Arm it here, of both kinds. A relative routine used to be stored with
  // `next_run_at: null` on the theory that the worker would compute it from the
  // anchor rows — but the worker's only query is `.lte('next_run_at', now)`,
  // which null never matches, so `nextRelativeFire` was reached only AFTER a
  // rule had already fired. Relative routines were unreachable by construction:
  // "two days before every trip" could never fire, ever.
  //
  // Null is still possible and still correct — a family with no trip on file
  // has nothing to count back from — and the worker's arming pass picks it up
  // as soon as one exists.
  const nextRunAt = schedule.kind === 'cron'
    ? nextCronRun(schedule.expr, now, scope.tz)
    : await nextRelativeFire(db, scope.familyId, schedule, now, scope.tz);

  const { data, error } = await db
    .from('family_automation_rules')
    .insert({
      family_id: scope.familyId,
      name: input.name?.trim() || prompt.slice(0, 80),
      trigger_type: 'schedule',
      trigger_config: {},
      action_type: 'ai_request',
      action_config: { prompt },
      is_enabled: true,
      created_by: scope.userId,
      said: schedule.said,
      schedule_kind: schedule.kind,
      schedule_expr: schedule.kind === 'cron' ? schedule.expr : null,
      anchor_key: schedule.kind === 'relative' ? schedule.anchor.key : null,
      offset_days: schedule.kind === 'relative' ? schedule.offsetDays : null,
      at_hour: schedule.kind === 'relative' ? schedule.atHour : null,
      // A relative routine's next fire is computed from its anchor rows by the
      // worker, because the anchor moves; a cron's is fixed here.
      next_run_at: nextRunAt ? nextRunAt.toISOString() : null,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:routines] create failed', error);
    return fail(describeDbError(error, 'Could not save that routine.'), { code: SERVICE_CODES.db });
  }
  return ok(toRoutine(data as RuleRow));
}

/** The family's routines, newest first. */
export async function listRoutines(scope: ServiceScope, opts?: { db?: DB; includeDisabled?: boolean }): Promise<ServiceResult<Routine[]>> {
  let query = (opts?.db ?? scope.db)
    .from('family_automation_rules')
    .select('*')
    .eq('family_id', scope.familyId)
    .not('schedule_kind', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (!opts?.includeDisabled) query = query.eq('is_enabled', true);
  const { data, error } = await query;
  if (error) {
    console.error('[service:routines] list failed', error);
    return fail(describeDbError(error, 'Could not read your routines.'), { code: SERVICE_CODES.db });
  }
  return ok((data ?? []).map((row) => toRoutine(row as RuleRow)));
}

/** Pause or resume a routine. Manager-only, like creating one. */
export async function setRoutineEnabled(scope: ServiceScope, routineId: string, enabled: boolean, opts?: { db?: DB }): Promise<ServiceResult<Routine>> {
  if (!isManager(scope.role)) {
    return fail('Only a parent or adult can pause a routine.', { code: SERVICE_CODES.denied });
  }
  const { data, error } = await (opts?.db ?? scope.db)
    .from('family_automation_rules')
    .update({ is_enabled: enabled, updated_by: scope.userId })
    .eq('id', routineId)
    .eq('family_id', scope.familyId)
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:routines] pause failed', error);
    return fail(describeDbError(error, 'Could not change that routine.'), { code: SERVICE_CODES.db });
  }
  return ok(toRoutine(data as RuleRow));
}

/** The schedule of a rule row, rebuilt from its columns (the worker's view). */
export function scheduleOf(row: Pick<RuleRow, 'schedule_kind' | 'schedule_expr' | 'anchor_key' | 'offset_days' | 'at_hour' | 'said'>): Schedule | null {
  if (row.schedule_kind === 'cron' && row.schedule_expr) {
    return { kind: 'cron', expr: row.schedule_expr, said: row.said ?? '' };
  }
  if (row.schedule_kind === 'relative' && row.anchor_key && row.offset_days !== null) {
    const anchor = anchorByKey(row.anchor_key);
    if (!anchor) return null;
    return { kind: 'relative', anchor, offsetDays: row.offset_days, atHour: row.at_hour ?? 9, said: row.said ?? '' };
  }
  return null;
}

/**
 * When a relative routine should next fire: the soonest anchor row that still
 * has its moment ahead of it.
 *
 * Read through the allow-listed table and column only, and always filtered by
 * family — the anchor names a table, and the one thing that must never happen
 * is a sentence choosing which table a query reads.
 */
export async function nextRelativeFire(
  db: DB, familyId: string, schedule: RelativeSchedule, from: Date, tz: string,
): Promise<Date | null> {
  // The dynamic table/column comes from `ROUTINE_ANCHORS`, never from what a
  // family typed, and the query is family-filtered like every other read — the
  // cast is only because `select()` cannot type a column name chosen at runtime.
  const { data, error } = await (db.from(schedule.anchor.table) as unknown as {
    select(columns: string): {
      eq(c: string, v: unknown): {
        not(c: string, op: string, v: unknown): {
          gte(c: string, v: unknown): {
            order(c: string, o: { ascending: boolean }): {
              limit(n: number): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
            };
          };
        };
      };
    };
  })
    .select(schedule.anchor.dateField)
    .eq('family_id', familyId)
    .not(schedule.anchor.dateField, 'is', null)
    .gte(schedule.anchor.dateField, new Date(from.getTime() - Math.abs(schedule.offsetDays) * 86_400_000).toISOString().slice(0, 10))
    .order(schedule.anchor.dateField, { ascending: true })
    .limit(20);
  if (error) {
    console.error('[service:routines] anchor read failed', error);
    return null;
  }
  const fires = (data ?? [])
    .map((row) => row[schedule.anchor.dateField])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => nextRelativeRun(schedule, value.slice(0, 10), from, tz))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return fires[0] ?? null;
}
