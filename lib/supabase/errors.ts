// Friendly, user-facing messages for Supabase/Postgres errors.
// Distinguishes permission (RLS) failures, missing rows, conflicts, and
// network problems from generic errors so the UI can show something honest
// and actionable instead of a raw Postgres string.

export type DbErrorLike =
  | { message?: string | null; code?: string | null; details?: string | null }
  | null
  | undefined;

/**
 * True when an error means the table/relation simply isn't provisioned yet —
 * PostgREST `PGRST205` ("Could not find the table ... in the schema cache") or
 * Postgres `42P01` (undefined_table). Used to degrade un-migrated features to a
 * friendly empty state instead of a scary error, so a pending migration never
 * breaks the UI. Forward-compatible: once the migration lands, data appears.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error) return false;
  const obj = (typeof error === 'object' ? error : { message: String(error) }) as DbErrorLike;
  const code = (obj?.code ?? '').toString();
  const msg = (obj?.message ?? '').toString().toLowerCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    (msg.includes('could not find the table') && msg.includes('schema cache')) ||
    msg.includes('relation') && msg.includes('does not exist')
  );
}

/**
 * Turn a Supabase error (or any thrown value) into a short, human message.
 * Never returns an empty string. Falls back to the raw message, then a
 * generic line.
 */
export function describeDbError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!error) return fallback;

  // Unwrap thrown Error/string values.
  const obj: DbErrorLike =
    typeof error === 'object' ? (error as DbErrorLike) : { message: String(error) };

  const code = (obj?.code ?? '').toString();
  const raw = (obj?.message ?? '').toString();
  const msg = raw.toLowerCase();

  // RLS / permission — Postgres 42501 (insufficient_privilege) or policy text.
  if (
    code === '42501' ||
    msg.includes('row-level security') ||
    msg.includes('violates row-level') ||
    msg.includes('permission denied') ||
    msg.includes('not allowed') ||
    msg.includes('policy')
  ) {
    return "You don't have permission to do that. Ask a family admin if you think this is a mistake.";
  }

  // Unique / conflict — 23505.
  if (code === '23505' || msg.includes('duplicate key') || msg.includes('already exists')) {
    return 'That already exists. Try a different value.';
  }

  // Foreign key / not found — 23503 or PostgREST PGRST116 (no rows).
  if (code === '23503' || code === 'PGRST116' || msg.includes('not found') || msg.includes('no rows')) {
    return 'That item could not be found — it may have already been removed.';
  }

  // Not-null / check constraint — 23502 / 23514.
  if (code === '23502' || code === '23514' || msg.includes('violates check') || msg.includes('null value')) {
    return 'Some required information is missing or invalid. Please review and try again.';
  }

  // Network / fetch transport.
  if (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  ) {
    return 'Network problem — check your connection and try again.';
  }

  return raw.trim() || fallback;
}

/**
 * True when an error means the table/column/relation isn't present yet — e.g. a
 * migration hasn't been applied to this database. PostgREST reports these as
 * "Could not find the table '…' in the schema cache" (PGRST205/PGRST204) or
 * Postgres 42P01 (undefined_table) / 42703 (undefined_column). Callers can use
 * this to degrade gracefully (treat as empty) instead of surfacing a crash.
 */
export function isMissingRelationError(error: unknown): boolean {
  if (!error) return false;
  const obj: DbErrorLike =
    typeof error === 'object' ? (error as DbErrorLike) : { message: String(error) };
  const code = (obj?.code ?? '').toString();
  const msg = (obj?.message ?? '').toString().toLowerCase();
  return (
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    code === '42P01' ||
    code === '42703' ||
    msg.includes('schema cache') ||
    (msg.includes('could not find') && msg.includes('table')) ||
    msg.includes('does not exist')
  );
}
