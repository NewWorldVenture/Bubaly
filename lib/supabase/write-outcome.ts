// lib/supabase/write-outcome.ts — did a failed write certainly not happen?
//
// supabase-js resolves every failure as `{ data: null, error }`, but two very
// different things hide behind that error:
//
//   - The database refused the statement. PostgREST answers with the
//     SQLSTATE Postgres raised (`23503`, `42501`, …) or one of its own
//     `PGRST…` codes, and the request's transaction rolled back. Nothing
//     was written.
//   - No answer came back. The connection dropped or a gateway timed out
//     (supabase-js reports `code: ''`, or a body with no code at all). The
//     statement may well have committed; the reply is what was lost.
//
// Undoing "the rest" of a change, or deleting what the write would have
// pointed at, is only safe in the first case. HC1 (an item form's photo) and
// HC2 (a closet wear's counts) both ask this before they clean up.

/** True only when the database answered and refused: the write did not happen. */
export function writeWasRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() !== '';
}
