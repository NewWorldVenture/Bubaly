// lib/autopilot/reminder-key.ts — the two stamps an accepted Autopilot card
// writes on the reminder it makes, minted where node:crypto is not.
//
// resolveSuggestion (lib/services/autopilot) writes a manager's "Add reminder"
// as a `family_reminders` row carrying
//
//   its key   `idempotency_key`, suggestionReminderKey: makeKey([
//             'autopilot.createReminder', familyId, suggestionId])
//   its tag   an AUTOPILOT_SOURCE_TAG tag, suggestionSourceTag: makeKey over
//             the card's family, id, kind, action, title, detail, member,
//             urgency and payload
//
// each a sha-256 minted with node:crypto. A reader finds the card such a row
// was made from by minting both for each card (lib/autopilot/reminder-cards.ts
// `keyOf` and `sourceTagOf`). The key is that one row's; the tag travels with
// the tags onto the next occurrence of a repeating one (the reminders
// module's, the assistant's complete_reminder), which carries no key. Found
// by neither, the row is "could be any card's", and is listed to the managers
// alone — the reminder of a card for everyone included.
//
// The reminders module reads `family_reminders` in the browser, where
// node:crypto is not, and the reminders service's lists mint here too: the
// service is imported BY lib/services/autopilot (only its exact-id guard,
// lib/services/reminders/shown.ts, imports the server's mints back, and calls
// them once a request runs). These mint the same stamps with Web Crypto: the same
// parts, normalised as makeKey normalises them (a string trimmed, a number
// kept, a missing part null), JSON-encoded, hashed, hex.
// tests/a-cards-reminder-in-the-reminder-lists-is-listed-only-to-its-readers.test.ts
// holds the keys equal, and
// tests/a-cards-reminder-copied-without-its-key-is-read-by-its-stamp.test.ts
// the tags.
//
// The tag is minted from the card's payload without SCAN_REMINDER_ID_KEY
// (stampedPayload): the scan's record of the reminder it wrote for an
// auto-executed card is bookkeeping, not what the card proposed.
//
// Client-safe.
import type { Tables } from '@/lib/database.types';
import { AUTOPILOT_SOURCE_TAG } from '@/lib/reminders/provenance';

/** What a card's tag is minted from (lib/services/autopilot suggestionSourceTag). */
export type SuggestionStampSource = Pick<Tables<'autopilot_suggestions'>,
  'family_id' | 'id' | 'kind' | 'action_type' | 'title' | 'detail' | 'member_id' | 'urgency' | 'payload'>;

/**
 * The payload key under which the scan records, on an auto-executed card, the
 * id of the `reminders` row it wrote for that card just before saving it
 * (lib/autopilot/scan.ts). A reader finds the scan's reminder's card by it
 * (lib/autopilot/reminder-cards.ts).
 */
export const SCAN_REMINDER_ID_KEY = 'reminder_id';

/**
 * The payload a card's tag is minted from: the card's own, less the scan's
 * record of the reminder it wrote (SCAN_REMINDER_ID_KEY). That record is
 * bookkeeping saved with the card, not what the card proposed — as the
 * status and timestamps the tag already leaves out are — so it never changes
 * a tag. A payload without one (every card saved before the scan recorded it,
 * and every open card, the only kind a manager accepts) is the very object
 * it was, and mints the tag it always minted.
 */
export function stampedPayload(payload: SuggestionStampSource['payload']): SuggestionStampSource['payload'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !(SCAN_REMINDER_ID_KEY in payload)) return payload;
  const proposed = { ...payload };
  delete proposed[SCAN_REMINDER_ID_KEY];
  return proposed;
}

/** makeKey (lib/services/idempotency) over flat parts, with Web Crypto. */
async function mintKey(parts: (string | number | null | undefined)[]): Promise<string> {
  const normalised = parts.map((part) => (part === null || part === undefined ? null : typeof part === 'string' ? part.trim() : part));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalised)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * suggestionReminderKey, minted with Web Crypto. Rejects where the page has no
 * `crypto.subtle` (an insecure origin); a reader then treats the cards as
 * unreadable, which lists their reminders to the managers alone.
 */
export async function mintSuggestionReminderKey(familyId: string, suggestionId: string): Promise<string> {
  return mintKey(['autopilot.createReminder', familyId, suggestionId]);
}

/**
 * suggestionSourceTag, minted with Web Crypto: the AUTOPILOT_SOURCE_TAG tag
 * resolveSuggestion writes beside the key. Rejects as the key's mint does.
 */
export async function mintSuggestionSourceTag(card: SuggestionStampSource): Promise<string> {
  return `${AUTOPILOT_SOURCE_TAG}${await mintKey([card.family_id, card.id, card.kind, card.action_type,
    card.title, card.detail, card.member_id, card.urgency, JSON.stringify(stampedPayload(card.payload))])}`;
}
