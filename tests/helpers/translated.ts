import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

// The read-boundary tests assert that a failed read renders a NAMED error and a
// retry link rather than an empty page. They used to do that by grepping the
// source for the English words, which stopped working the moment those words
// moved into the catalogue — 124 assertions across 92 files, all of them
// green-to-red for a reason that had nothing to do with the invariant.
//
// The invariant is unchanged, so the assertion is kept and split in two:
//
//   * the page still REACHES that string, by key — so it cannot lose the notice;
//   * the catalogue still SAYS it, in English — so it cannot quietly become
//     different words.
//
// Asserting only the key would let "Could not load support tickets" be edited
// into anything at all without a test noticing. Asserting only the English
// would pass on a page that no longer renders it.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

export function expectSays(source: string, key: string, english: string): void {
  expect(source, `should render ${key}`).toContain(key);
  expect(MESSAGES[key], `${key} should still say "${english}"`).toBe(english);
}

/**
 * The same two-part assertion for a string a SERVER ACTION or route handler
 * words itself: the source must call the translator on that key, and the
 * catalogue must still say the English.
 *
 * Stricter than `expectSays` on the source half — `toContain(key)` would pass
 * on a bare key sitting in a data array, which is exactly the mistake that
 * renders `actions.orderNotFound` at a user. The call has to be there.
 */
export function expectTranslates(source: string, key: string, english: string): void {
  const call = new RegExp(`\\b(?:t|tr|tx|translate_)\\('${key.replace(/\./g, '\\.')}'\\)`);
  expect(source, `should translate ${key}, not hand back the key`).toMatch(call);
  expect(MESSAGES[key], `${key} should still say "${english}"`).toBe(english);
}
