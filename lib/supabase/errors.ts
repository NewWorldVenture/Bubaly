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
 * e.g. a migration hasn't been applied to this database. Used to degrade
 * un-migrated features to a friendly empty state instead of a scary error, so a
 * pending migration never breaks the UI. Forward-compatible: once the migration
 * lands, data appears. Alias of `isMissingRelationError` (single source of
 * truth); kept for call sites that import this name.
 */
export function isMissingTableError(error: unknown): boolean {
  return isMissingRelationError(error);
}

/**
 * Turn a Supabase error (or any thrown value) into a short, human message.
 * Never returns an empty string.
 *
 * An unclassified error falls back to the caller's `fallback`, NOT to the raw
 * string — see the note at the bottom of the function. The one exception is an
 * error with no Postgres code, which the application threw itself and whose
 * message was written for a person to read.
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

  // Everything above is a message this file WROTE. What is left is the raw
  // string as the database phrased it, and the ten shapes matched above are not
  // the only shapes there are: an enum coercion, a numeric overflow, a
  // function-not-found and a provider error re-thrown as an Error all fall
  // through here. Returning them hands out schema — type names, column names,
  // constraint names, function signatures — to anyone who can make a query
  // fail. On the AI paths it goes further: `lib/ai/tools/*` put this string into
  // `fail(...)`, which reaches the model's context as well as the browser.
  //
  //   insert … status = 'bogus'
  //     → invalid input value for enum redemption_status: "bogus"
  //
  // is the whole grammar of a type, from one failed write.
  //
  // The distinction that matters is not "raw" but WHO WROTE IT. An error the
  // application threw itself — `throw new Error('Pick a date first')` — has no
  // Postgres code and its message was written for a person, so it is still the
  // best thing to show. Anything carrying a code came from the database or a
  // provider, and its message was written for whoever maintains the schema.
  if (!code) return raw.trim() || fallback;
  return fallback;
}

/** Describe an error for a server-action/API response without exposing
 * unclassified database or provider details to the browser or model.
 *
 * Since `describeDbError` stopped returning coded raw strings this is a
 * narrower thing than it was: it now only catches the CODELESS unclassified
 * error — an `Error` the application threw that says nothing a person can act
 * on. Still worth having on a response boundary, and still the right default
 * there; it is no longer the only thing standing between a Postgres string and
 * the browser. */
export function describeActionError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const described = describeDbError(error, fallback);
  const raw = typeof error === 'object' && error !== null
    ? String((error as { message?: unknown }).message ?? '').trim()
    : typeof error === 'string' ? error.trim() : '';
  return raw && described === raw ? fallback : described;
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
