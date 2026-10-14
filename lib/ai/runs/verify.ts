// Workflow-level verification — §13, "the AI must verify its own work".
//
// A tool returning `ok` proves the write was accepted, not that the household
// ended up in the state the plan promised. The vacation example in the spec is
// the honest test: the traveller records exist, the packing list exists, the
// critical tasks are assigned, the dates are right, the reminders are
// scheduled, and nothing conflicts — only then is the workflow complete. This
// module turns a `verify` step's declarative spec into those re-reads and
// reports what it found, so a run that wrote six of eight things says so
// instead of claiming success.
//
// The checks read ONLY through the allow-list below. A verify step's spec is
// authored by the planner — an LLM — and `table` is a string in it; without the
// allow-list a crafted plan could turn the verifier into a generic table reader
// and leak row contents into a run event that every family member can read.
import 'server-only';
import { z } from 'zod';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { shownReminders, type ShownReminderRow } from '@/lib/services/reminders/shown';
import { readAll } from '@/lib/supabase/read-all';
import { findConflicts } from '@/lib/services/calendar';
import { BINDING_KEY } from './bindings';

/**
 * Tables a verification may re-read: the family-scoped tables the AI's own
 * tools write. Every one has `id` and `family_id`, which is what the queries
 * below rely on.
 */
export const VERIFIABLE_TABLES = [
  'calendar_events', 'todo_items', 'chores', 'chore_assignments',
  'family_reminders', 'grocery_items', 'meal_plans', 'notes',
] as const;

export type VerifiableTable = (typeof VERIFIABLE_TABLES)[number];

const tableSchema = z.enum(VERIFIABLE_TABLES);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * `records_exist`  — the rows the plan claims to have written are really there.
 * `fields_match`   — a row exists AND carries the values the plan intended
 *                    (the "createEvent → retrieveEvent → confirm" loop).
 * `count_at_least` — a fan-out produced enough rows (e.g. seven meal plans).
 * `no_calendar_conflicts` — nothing double-books the window we just filled.
 */
/**
 * An id a step will produce, written before the run starts.
 *
 * A spec is validated at PLAN time, when the rows it will name do not exist
 * yet, and run at EXECUTION time, when `resolveBindings` has already replaced
 * every binding with the real id. So the schema accepts both shapes and the
 * runner refuses a binding that reached it — a check that quietly treated
 * `{"$fromStep":…}` as an id would look like it passed while proving nothing,
 * which is the exact failure this whole mechanism exists to end.
 */
const idOrBinding = z.union([
  z.string().uuid(),
  z.object({ [BINDING_KEY]: z.string().min(1), path: z.string().min(1) }).strict(),
]);

export const verificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('records_exist'), table: tableSchema, ids: z.array(idOrBinding).min(1).max(100), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal('fields_match'), table: tableSchema, id: idOrBinding, expect: z.record(scalar), label: z.string().max(120).optional() }),
  z.object({
    kind: z.literal('count_at_least'), table: tableSchema, min: z.number().int().min(1).max(500), where: z.record(scalar).optional(),
    // An inclusive range on one column — the week a plan is for — so rows from
    // another week cannot satisfy the count (`meal_plans.plan_date`).
    between: z.object({ column: z.string().regex(/^[a-z_][a-z0-9_]*$/), from: z.string().min(1), to: z.string().min(1) }).strict().optional(),
    label: z.string().max(120).optional(),
  }),
  z.object({ kind: z.literal('no_calendar_conflicts'), start: z.string().min(4), end: z.string().min(4), label: z.string().max(120).optional() }),
]);

export const verificationSpecSchema = z.object({
  checks: z.array(verificationCheckSchema).min(1).max(20),
});

export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationSpec = z.infer<typeof verificationSpecSchema>;

export type CheckOutcome = { kind: VerificationCheck['kind']; label: string; verified: boolean; detail: string };
export type VerificationOutcome = { verified: boolean; detail: string; checks: CheckOutcome[] };

/** Parse a `verify` step's `input_json`. A malformed spec is a planner bug, not a household problem — it fails the step, never the whole run silently. */
export function parseVerificationSpec(input: unknown): ServiceResult<VerificationSpec> {
  const parsed = verificationSpecSchema.safeParse(input);
  if (!parsed.success) {
    return fail(`That verification step is not something Bubaly can check: ${parsed.error.issues[0]?.message ?? 'invalid spec'}.`, {
      code: SERVICE_CODES.invalidInput,
    });
  }
  return ok(parsed.data);
}

/**
 * WHY this cast: `supabase.from()` is generic over a single literal table name,
 * so calling it with a union of names yields a union of query builders that
 * TypeScript will not let you call. The allow-list above is what keeps the
 * dynamic name safe, and every query below still filters `family_id`, so the
 * service client's RLS bypass cannot reach another household.
 */
type Filterable = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> & {
  eq(column: string, value: unknown): Filterable;
  in(column: string, values: readonly unknown[]): Filterable;
  lt(column: string, value: unknown): Filterable;
  gte(column: string, value: unknown): Filterable;
  lte(column: string, value: unknown): Filterable;
  is(column: string, value: unknown): Filterable;
  limit(count: number): Filterable;
  order(column: string): Filterable;
  range(from: number, to: number): Filterable;
};
type DynamicReader = { from(table: string): { select(columns: string): Filterable } };

/**
 * What a re-read of `family_reminders` selects beside its own columns: the
 * links the reader's rule reads (lib/services/reminders/shown.ts).
 */
const REMINDER_LINKS = 'id, member_id, idempotency_key, tags';

/**
 * The rows of a re-read this run's reader may be shown. Every other table here
 * is the whole family's to read; `family_reminders` is not, for its card-made
 * rows are their card's readers' alone. A teen's plan that named a policy
 * reminder's id was answered whether its title was the one guessed — by
 * `fields_match`, and by `count_at_least` with `where: { id, title }` — and
 * whether it existed, by `records_exist`. Each check keeps only the rows its
 * reader is shown before it compares, finds or counts, so a hidden reminder
 * answers as an id the family does not hold. Null when the cards could not be
 * read: the check then fails as a read that failed, never a guess.
 */
async function shownRows(scope: ServiceScope, table: VerifiableTable, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[] | null> {
  if (table !== 'family_reminders') return rows;
  const shown = await shownReminders(scope, rows as (Record<string, unknown> & ShownReminderRow)[]);
  return shown.ok ? shown.data : null;
}

function labelFor(check: VerificationCheck): string {
  if (check.label) return check.label;
  switch (check.kind) {
    case 'records_exist': return `${check.ids.length} ${check.table.replace(/_/g, ' ')} record(s) exist`;
    case 'fields_match': return `${check.table.replace(/_/g, ' ')} record matches the plan`;
    case 'count_at_least': return `at least ${check.min} ${check.table.replace(/_/g, ' ')} record(s)`;
    case 'no_calendar_conflicts': return 'no double-booked events';
  }
}

/** Compare a stored value with the expected one. Timestamps are compared as instants so '2026-09-05T10:00:00Z' matches '2026-09-05T10:00:00+00:00'. */
function valuesMatch(actual: unknown, expected: string | number | boolean | null): boolean {
  if (actual === expected) return true;
  if (expected === null || actual === null || actual === undefined) return false;
  if (typeof expected === 'string' && typeof actual === 'string') {
    if (actual === expected) return true;
    const a = Date.parse(actual);
    const b = Date.parse(expected);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
    return false;
  }
  return String(actual) === String(expected);
}

async function runCheck(scope: ServiceScope, check: VerificationCheck): Promise<CheckOutcome> {
  const reader = scope.db as unknown as DynamicReader;
  const label = labelFor(check);

  if (check.kind === 'no_calendar_conflicts') {
    // Real overlaps, as the calendar itself finds them (`findConflicts`, the
    // service behind the `calendar.findConflicts` step the same plans run):
    // every occurrence in the window — a weekly series expanded, an event with
    // no end given its usual hour — and a clash only where one person's two
    // timed events actually overlap. This used to COUNT the window's events
    // and call any two a clash, so every ordinary week failed "Plan our week"
    // and held back its summary, while a real clash with a weekly practice
    // (stored once, as its series) passed.
    const found = await findConflicts(scope, { from: check.start, to: check.end });
    if (!found.ok) return { kind: check.kind, label, verified: false, detail: found.error };
    const clashes = found.data.conflicts.length;
    if (clashes === 0) return { kind: check.kind, label, verified: true, detail: 'Nothing overlaps in that window.' };
    return {
      kind: check.kind, label, verified: false,
      detail: `${clashes} double-booking${clashes === 1 ? '' : 's'} between ${check.start} and ${check.end}.`,
    };
  }

  if (check.kind === 'records_exist') {
    const ids = check.ids.filter((id): id is string => typeof id === 'string');
    if (ids.length !== check.ids.length) {
      return { kind: check.kind, label, verified: false, detail: 'Bubaly could not work out which records this was meant to check.' };
    }
    const { data, error } = await reader
      .from(check.table)
      .select(check.table === 'family_reminders' ? REMINDER_LINKS : 'id')
      .eq('family_id', scope.familyId)
      .in('id', ids)
      .limit(ids.length);
    if (error) return { kind: check.kind, label, verified: false, detail: describeDbError(error, 'Bubaly could not re-read what it wrote.') };
    const shown = await shownRows(scope, check.table, data ?? []);
    if (!shown) return { kind: check.kind, label, verified: false, detail: 'Bubaly could not re-read what it wrote.' };
    const found = new Set(shown.map((row) => String(row.id)));
    const missing = ids.filter((id) => !found.has(id));
    return missing.length
      ? { kind: check.kind, label, verified: false, detail: `${missing.length} of ${ids.length} records are missing.` }
      : { kind: check.kind, label, verified: true, detail: `All ${ids.length} records are there.` };
  }

  if (check.kind === 'fields_match') {
    if (typeof check.id !== 'string') {
      return { kind: check.kind, label, verified: false, detail: 'Bubaly could not work out which record this was meant to check.' };
    }
    const { data, error } = await reader
      .from(check.table)
      .select('*')
      .eq('family_id', scope.familyId)
      .eq('id', check.id)
      .limit(1);
    if (error) return { kind: check.kind, label, verified: false, detail: describeDbError(error, 'Bubaly could not re-read what it wrote.') };
    // A hidden reminder is no record of this reader's to compare a guess against.
    const shown = await shownRows(scope, check.table, data ?? []);
    if (!shown) return { kind: check.kind, label, verified: false, detail: 'Bubaly could not re-read what it wrote.' };
    const row = shown[0];
    if (!row) return { kind: check.kind, label, verified: false, detail: 'That record no longer exists.' };
    const wrong = Object.entries(check.expect).filter(([column, expected]) => !valuesMatch(row[column], expected));
    return wrong.length
      ? { kind: check.kind, label, verified: false, detail: `${wrong.map(([c]) => c).join(', ')} did not come out as planned.` }
      : { kind: check.kind, label, verified: true, detail: 'The saved record matches the plan.' };
  }

  const where = (query: Filterable) => {
    for (const [column, value] of Object.entries(check.where ?? {})) {
      query = value === null ? query.is(column, null) : query.eq(column, value);
    }
    if (check.between) query = query.gte(check.between.column, check.between.from).lte(check.between.column, check.between.to);
    return query;
  };
  // A reminder is counted only when this reader is shown it, so every match
  // is read and the hidden ones dropped before the count: the first `min`
  // matches may include rows the reader is not shown.
  let data: Record<string, unknown>[] | null;
  let error: unknown;
  if (check.table === 'family_reminders') {
    ({ rows: data, error } = await readAll<Record<string, unknown>, unknown>((from, to) => where(reader
      .from('family_reminders')
      .select(REMINDER_LINKS)
      .eq('family_id', scope.familyId))
      .order('id')
      .range(from, to)));
  } else {
    ({ data, error } = await where(reader.from(check.table).select('id').eq('family_id', scope.familyId)).limit(check.min));
  }
  if (error) return { kind: check.kind, label, verified: false, detail: describeDbError(error, 'Bubaly could not count what it wrote.') };
  const shown = await shownRows(scope, check.table, data ?? []);
  if (!shown) return { kind: check.kind, label, verified: false, detail: 'Bubaly could not count what it wrote.' };
  // As many as the check asked for, at most, as a read of `min` rows counts.
  const count = Math.min(shown.length, check.min);
  return count >= check.min
    ? { kind: check.kind, label, verified: true, detail: `Found ${count}.` }
    : { kind: check.kind, label, verified: false, detail: `Found ${count}, expected at least ${check.min}.` };
}

/**
 * Run every check in a spec. Checks are independent re-reads, so they run
 * concurrently; the outcome is verified only when all of them are, and the
 * detail line names what actually failed so the run timeline is useful without
 * opening the database.
 */
export async function runVerification(scope: ServiceScope, spec: VerificationSpec): Promise<ServiceResult<VerificationOutcome>> {
  const settled = await Promise.all(spec.checks.map((check) => runCheck(scope, check)));
  const failed = settled.filter((c) => !c.verified);
  const detail = failed.length
    ? `${settled.length - failed.length} of ${settled.length} checks passed — ${failed.map((c) => `${c.label}: ${c.detail}`).join('; ')}`
    : `All ${settled.length} checks passed.`;
  return ok({ verified: failed.length === 0, detail, checks: settled });
}

// ─── Builders ───────────────────────────────────────────────────────────────
// The planner and the workflow templates compose specs from these rather than
// hand-writing the jsonb, so a typo in a table name is a compile error.

export function recordsExist(table: VerifiableTable, ids: string[], label?: string): VerificationCheck {
  return { kind: 'records_exist', table, ids, ...(label ? { label } : {}) };
}

export function fieldsMatch(table: VerifiableTable, id: string, expect: Record<string, string | number | boolean | null>, label?: string): VerificationCheck {
  return { kind: 'fields_match', table, id, expect, ...(label ? { label } : {}) };
}

export function countAtLeast(table: VerifiableTable, min: number, where?: Record<string, string | number | boolean | null>, label?: string): VerificationCheck {
  return { kind: 'count_at_least', table, min, ...(where ? { where } : {}), ...(label ? { label } : {}) };
}

/** Reminders are only "scheduled" if the rows exist AND still carry a future `remind_at`; the caller passes the ids it created. */
export function remindersScheduled(ids: string[]): VerificationCheck {
  return recordsExist('family_reminders', ids, `${ids.length} reminder(s) scheduled`);
}

export function noCalendarConflicts(start: string, end: string): VerificationCheck {
  return { kind: 'no_calendar_conflicts', start, end };
}
