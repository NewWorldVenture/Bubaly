/**
 * Escape a value that is about to be used as a LIKE/ILIKE *pattern*.
 *
 * `%` and `_` are wildcards, so a value interpolated into a pattern unescaped
 * stops being a value and becomes a query. That has already been a live defect
 * in this repository more than once — child sign-in, then inbound email routing,
 * where a `To` header of `smit_h` reached the family whose local part is
 * `smith`. Both were fixed where they were found, and the fix did not reach the
 * other call sites, which is why this lives in one place now.
 *
 * The backslash goes FIRST and is escaped too. LIKE's default escape character
 * is the backslash, so a value containing one silently swallows the character
 * after it — measured in Postgres 16: `'ab' ilike 'a\b'` is TRUE. Every local
 * copy of this helper in the repository escapes only `%` and `_` and therefore
 * still has that hole.
 *
 * Escaping is the right tool where case-insensitive matching is wanted; where an
 * exact match is wanted, `.eq()` is better than an escaped pattern.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
