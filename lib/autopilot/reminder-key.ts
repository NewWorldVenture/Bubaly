// lib/autopilot/reminder-key.ts — the key an accepted Autopilot card stamps on
// the reminder it writes, minted where node:crypto is not.
//
// resolveSuggestion (lib/services/autopilot) writes a manager's "Add reminder"
// as a `family_reminders` row whose `idempotency_key` is
// suggestionReminderKey: makeKey(['autopilot.createReminder', familyId,
// suggestionId]), a sha-256 minted with node:crypto. A reader finds the card
// such a row was made from by minting the same key for each card
// (lib/autopilot/reminder-cards.ts `keyOf`). Without it the row is "could be
// any card's", and is listed to the managers alone — the reminder of a card
// for everyone included.
//
// The reminders module reads `family_reminders` in the browser, and the
// reminders service is imported BY lib/services/autopilot, so neither can call
// suggestionReminderKey. This mints the same key with Web Crypto: the same
// three parts, each trimmed as makeKey trims a string, JSON-encoded, hashed,
// hex. tests/a-cards-reminder-in-the-reminder-lists-is-listed-only-to-its-readers.test.ts
// holds the two equal.
//
// Client-safe.

/**
 * suggestionReminderKey, minted with Web Crypto. Rejects where the page has no
 * `crypto.subtle` (an insecure origin); a reader then treats the cards as
 * unreadable, which lists their reminders to the managers alone.
 */
export async function mintSuggestionReminderKey(familyId: string, suggestionId: string): Promise<string> {
  const text = JSON.stringify(['autopilot.createReminder', familyId, suggestionId].map((part) => part.trim()));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
