// Friendly, user-facing messages for Supabase/Postgres errors.
// Distinguishes permission (RLS) failures, missing rows, conflicts, and
// network problems from generic errors so the UI can show something honest
// and actionable instead of a raw Postgres string.

// ── The five classified sentences, in the reader's language (I18N-011) ──────
//
// They were English literals, so a German family refused by RLS read English
// on an otherwise German screen. describeDbError is a plain synchronous
// function with ~730 callers on both sides of the network, so it cannot take
// a translator from each of them; the sentences reach the reader two ways:
//
//   1. IN THE BROWSER, each mounted `LocaleProvider` registers the five
//      sentences of the locale it renders, and describeDbError answers in the
//      latest one's. Registered in an effect (and taken out in its cleanup)
//      rather than during render: a server-rendered error is English (the
//      server has no reader to remember), and the client's first render must
//      say the same thing or hydration fails.
//   2. ON THE SCREEN, for a sentence written on the SERVER (a server action's
//      `{ error }`, already English when it arrives): the toast, ActionError
//      and a form field's error put each of the five sentences they carry into
//      the reader's language with their own `t`, server-rendered or not.
//
// This file imports nothing, on purpose: a dozen tests load it in a sandbox
// that refuses any import it does not list, and e2e fixtures mount it by
// path. en-US.json holds the same five sentences; a test keeps them identical.

export const DB_ERROR_ENGLISH = {
  'dbError.permission': "You don't have permission to do that. Ask a family admin if you think this is a mistake.",
  'dbError.conflict': 'That already exists. Try a different value.',
  'dbError.notFound': 'That item could not be found — it may have already been removed.',
  'dbError.invalid': 'Some required information is missing or invalid. Please review and try again.',
  'dbError.network': 'Network problem — check your connection and try again.',
} as const;

export type DbErrorKey = keyof typeof DB_ERROR_ENGLISH;

const KEYS = Object.keys(DB_ERROR_ENGLISH) as DbErrorKey[];

/**
 * The sentences of every LocaleProvider mounted in the browser, in the order
 * they committed; the latest is the one describeDbError answers in. A provider
 * that unmounts takes its own entry out, so a nested one that goes away leaves
 * the one around it current again.
 */
const registrations: Partial<Record<DbErrorKey, string>>[] = [];

/**
 * Every language the five sentences have been seen in, sentence → key. Only
 * ever added to: English from the start, then each catalogue a provider renders
 * and each translator a display point uses. A refusal a toast or a field is
 * still holding, written while the reader was German, keeps its identity here,
 * so when the reader switches to French it is shown in French. The language a
 * sentence is SHOWN in is always the receiving component's own `t`; this only
 * says which of the five it is.
 */
const known = new Map<string, DbErrorKey>(KEYS.map((key) => [DB_ERROR_ENGLISH[key], key]));

function learn(lookup: (key: DbErrorKey) => string | undefined): void {
  for (const key of KEYS) {
    const sentence = lookup(key);
    if (sentence && sentence !== key) known.set(sentence, key);
  }
}

/**
 * Called by `LocaleProvider` once it has committed, in the browser only: the
 * server serves many readers at once, so a module-level choice there would be
 * whichever request rendered last. A catalogue without the five keys (a scope
 * that left them out) changes nothing. Returns the provider's way out, for its
 * effect's cleanup.
 */
export function rememberDbErrorText(messages: Readonly<Record<string, string>>): () => void {
  if (typeof window === 'undefined') return () => {};
  learn((key) => messages[key]);
  const entry: Partial<Record<DbErrorKey, string>> = {};
  for (const key of KEYS) if (messages[key]) entry[key] = messages[key];
  if (!Object.keys(entry).length) return () => {};
  registrations.push(entry);
  return () => {
    const at = registrations.lastIndexOf(entry);
    if (at >= 0) registrations.splice(at, 1);
  };
}

/** One of the five sentences, in the latest mounted provider's language, else English. */
export function dbErrorText(key: DbErrorKey): string {
  return registrations[registrations.length - 1]?.[key] ?? DB_ERROR_ENGLISH[key];
}

/**
 * Each of the five sentences inside `text`, in whatever language it was
 * written (English from a server action, or a language the reader has since
 * left), put into `t`'s language. Anything else is left as it was, and so is a
 * sentence whose key `t` does not hold (it answers with the key itself).
 */
export function localizeDbErrorText(text: string, t: (key: string) => string): string {
  learn(t);
  let out = text;
  for (const [sentence, key] of known) {
    if (!out.includes(sentence)) continue;
    const local = t(key);
    if (local && local !== key && local !== sentence) out = out.split(sentence).join(local);
  }
  return out;
}


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
    return dbErrorText('dbError.permission');
  }

  // Unique / conflict — 23505.
  if (code === '23505' || msg.includes('duplicate key') || msg.includes('already exists')) {
    return dbErrorText('dbError.conflict');
  }

  // Foreign key / not found — 23503 or PostgREST PGRST116 (no rows).
  if (code === '23503' || code === 'PGRST116' || msg.includes('not found') || msg.includes('no rows')) {
    return dbErrorText('dbError.notFound');
  }

  // Not-null / check constraint — 23502 / 23514.
  if (code === '23502' || code === '23514' || msg.includes('violates check') || msg.includes('null value')) {
    return dbErrorText('dbError.invalid');
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
    return dbErrorText('dbError.network');
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
 * PostgREST's answer for a FUNCTION the database does not have (yet) — PGRST202
 * from the schema cache, or 42883 from Postgres. A deploy can precede its
 * migration, so a caller of a new RPC falls back to what it did before rather
 * than failing the family's request. Shared so each new RPC does not grow its
 * own copy (the Resend webhook had one).
 */
export function isMissingFunctionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as NonNullable<DbErrorLike>;
  return code === 'PGRST202' || code === '42883' || /could not find the function/i.test(message ?? '');
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

/**
 * Did a write actually change a row?
 *
 * A browser-direct UPDATE or DELETE that row-level security filters out is NOT
 * an error. Postgres applies a restrictive policy's `using` clause as a FILTER,
 * so the statement matches nothing and succeeds. Measured on Postgres 16 with
 * the exact policy shape migration 0309 installs, as a non-manager:
 *
 *     update medications set dosage = '40 mg' where id = 1;  -> UPDATE 0   (dosage unchanged)
 *     delete from medications where id = 1;                  -> DELETE 0   (row still present)
 *     insert into medications values (…);                    -> ERROR 42501
 *
 * That asymmetry is the whole problem: `with check` (INSERT) raises, `using`
 * (UPDATE/DELETE) filters silently. So the RLS hardening those migrations added
 * is correct AND invisible to the client, and every call site that checked only
 * `error` went on to report success for a write that never happened.
 *
 * PostgREST only returns the affected rows when the request asks for them —
 * `.select()` is what appends `Prefer: return=representation`. Without it
 * `data` is null whether one row changed or none did, so a call site cannot
 * tell even in principle. Hence: add `.select('id')`, then use this.
 */
export function wroteNoRows(rows: unknown[] | null | undefined): boolean {
  return !rows || rows.length === 0;
}
