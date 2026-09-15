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
