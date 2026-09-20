import { expect } from 'vitest';

/**
 * Ordering assertions written so that a DELETED statement fails them.
 *
 * `haystack.indexOf(needle)` returns -1 when the needle is absent, and -1 is
 * less than every real index. An ordering guard written on bare `indexOf`
 * therefore passes *most convincingly* when the thing it is named for has been
 * removed. Audit C4-S5-02 proved eight such guards green against a codebase
 * with that statement deleted — among them a test named "the Stripe webhook
 * fulfils the reward right after marking the conversion", still 11/11 green
 * with `markReferralConverted` gone from the webhook entirely.
 *
 * `at()` asserts presence first, so absence is a failure rather than a
 * particularly emphatic pass. It covers source text and recorded call logs
 * alike, because the sentinel is a property of `indexOf`, not of strings.
 */
export function at(source: string, needle: string): number;
export function at<T>(source: readonly T[], needle: T): number;
export function at(source: string | readonly unknown[], needle: unknown): number {
  const i = (source as readonly unknown[]).indexOf(needle);
  expect(i, `expected to find: ${typeof needle === 'string' ? JSON.stringify(needle) : String(needle)}`)
    .toBeGreaterThan(-1);
  return i;
}

/**
 * The slice BETWEEN two needles, asserted non-empty.
 *
 * `at()` fixed the `-1` sentinel but not its sibling. `src.slice(at(src, a),
 * at(src, b))` looks like an ordering-safe slice and is not: both bounds are
 * searched from the start of the file, so if `b` occurs BEFORE `a` the slice is
 * the empty string — and every `toContain` on an empty string fails, while
 * every `not.toContain` passes. Found in this repository's own guard for the
 * native push branch, where a `} catch {` above the branch under test silently
 * emptied the slice and made three assertions vacuous.
 *
 * This asserts both needles are present AND in the stated order, so the
 * degenerate case is a failure rather than a quiet pass. Audit C1-S9-07.
 */
export function between(source: string, start: string, end: string): string {
  const a = at(source, start);
  const b = at(source, end);
  expect(b, `expected ${JSON.stringify(end)} to come after ${JSON.stringify(start)}`).toBeGreaterThan(a);
  return source.slice(a, b);
}
