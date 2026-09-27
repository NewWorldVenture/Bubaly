// A server action that refuses what it was given (a name already taken, a
// value out of range) and throws lands on the section's error page. In
// production Next omits the thrown message there, so the person saw
// "This page hit a snag" and a reference number, and was never told what to
// change. Next does keep an error's own `digest`, though, and hands it to the
// error boundary. A refusal therefore carries its reason in the digest, as one
// of a fixed set of codes — never free text, which would put whatever the
// action said on the page unescaped by any catalogue — and
// `components/app/section-error.tsx` turns the code into a sentence in the
// reader's language.
//
// Pure: no server-only imports, so the boundary can read the prefix too.

export const REFUSAL_DIGEST_PREFIX = 'ACTION_REFUSED:';

export const REFUSALS = ['duplicate', 'invalid', 'notAllowed', 'inUse', 'notSaved'] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The refusal a digest names, or null when the error is not a refusal. */
export function refusalFromDigest(digest: string | null | undefined): Refusal | null {
  if (typeof digest !== 'string' || !digest.startsWith(REFUSAL_DIGEST_PREFIX)) return null;
  const code = digest.slice(REFUSAL_DIGEST_PREFIX.length);
  return (REFUSALS as readonly string[]).includes(code) ? (code as Refusal) : null;
}

/**
 * The refusal a failed write amounts to, from its Postgres error code. An
 * error with no code is the action's own: "nothing came back" fallbacks read
 * as not saved, anything else as input the action refused.
 */
export function refusalForError(error: unknown): Refusal {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (code === '23505') return 'duplicate';
    if (code === '23503') return 'inUse';
    if (code === '42501') return 'notAllowed';
    if (/^(23514|23502|22P02|22001|22003|22007|22008|22023)$/.test(code)) return 'invalid';
    return 'notSaved';
  }
  const message = error instanceof Error ? error.message : '';
  if (/^No .+ (was|were) /i.test(message) || /not found|could not be saved/i.test(message)) return 'notSaved';
  return 'invalid';
}

/** An Error whose digest names the refusal, for an action to throw. */
export function refusalError(message: string, refusal: Refusal): Error {
  const error = new Error(message) as Error & { digest?: string };
  error.digest = `${REFUSAL_DIGEST_PREFIX}${refusal}`;
  return error;
}

/** Refuse input the action cannot accept, telling the reader it was the input. */
export function refuseInput(message: string, refusal: Refusal = 'invalid'): never {
  throw refusalError(message, refusal);
}
