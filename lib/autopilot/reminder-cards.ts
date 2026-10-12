// lib/autopilot/reminder-cards.ts — the Autopilot card a reminder was made from.
//
// A card's reminder is a second copy of the card, written by one of two paths:
//
//   the scan       an auto-executed card's `reminders` row — "Renew dental
//                  insurance (Smile Co)", related_type 'renewal', related_id the
//                  policy or renewal the card was made from (lib/autopilot/scan.ts)
//   a manager      an accepted card's `family_reminders` row, stamped with the
//                  card's idempotency key and an AUTOPILOT_SOURCE_TAG tag
//                  (lib/services/autopilot resolveSuggestion)
//
// Neither row carries the card's audience. An insurance card's reminder is
// unassigned so the managers who renew the policy are reminded
// (lib/autopilot/audience.ts reminderMemberFor), and a renewal's never had a
// member; read by "mine or nobody's", or by nothing at all, it reached every
// reader the card itself refuses — a guest shown "Renew Passport", a child the
// policy does not name shown "Renew dental insurance (Smile Co)".
//
// So whoever reads these reminders looks the card up here and applies the
// card's rule: the notifications generator to address the notice, and every
// screen and brief that lists a reminder's title to drop it for a reader the
// card is not for. A failed read of the cards never widens: a reminder that
// could be a card's is then the managers', who read every card.
//
// Client-safe: the briefing module's kitchen list, the Health page and the
// reminders module read their reminders in the browser. The key an accepted
// card stamps is a sha-256 (suggestionReminderKey), so a reader of
// `family_reminders` passes it in as `keyOf` — the server's mint, or the
// browser's (lib/autopilot/reminder-key.ts mintSuggestionReminderKey); without
// it such a row is treated as unreadable, never as nobody's card.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { readAll } from '@/lib/supabase/read-all';
import { AUTOPILOT_SOURCE_TAG } from '@/lib/reminders/provenance';
import { NARROWER_THAN_EVERYONE_FILTER, suggestionVisibleTo, type AudienceRow, type AudienceViewer } from '@/lib/autopilot/audience';

type DB = SupabaseClient<Database>;

export type ReminderCard = AudienceRow & { id: string; source_id: string | null };

/**
 * The family's narrower cards, by the two links a reminder carries back to
 * one. `byReminderKey` is null when the reader did not say how a key is minted.
 */
export type ReminderCards = { bySource: Map<string, ReminderCard>; byReminderKey: Map<string, ReminderCard> | null };

/** What a reminder row carries back to its card: `reminders` has the first two, `family_reminders` the last two. */
export type ReminderLink = {
  related_type?: string | null;
  related_id?: string | null;
  idempotency_key?: string | null;
  tags?: string[] | null;
};

export type ReminderCardsOptions = {
  /**
   * How an accepted card's reminder key is minted: lib/services/autopilot
   * suggestionReminderKey on the server, lib/autopilot/reminder-key.ts
   * mintSuggestionReminderKey in the browser. A mint that fails is a failed read.
   */
  keyOf?: (cardId: string) => string | PromiseLike<string>;
  /** Told when the cards could not be read; the reader then answers null. */
  onError: (error: unknown) => void;
};

/** The source a scan-made reminder names (lib/autopilot/scan.ts relatedType), or null. */
function scanSource(row: ReminderLink): string | null {
  return row.related_type === 'renewal' && row.related_id ? row.related_id : null;
}

/** The key an accepted card's reminder carries, or null. */
function acceptedKey(row: ReminderLink): string | null {
  return row.idempotency_key && (row.tags ?? []).some((tag) => tag.startsWith(AUTOPILOT_SOURCE_TAG)) ? row.idempotency_key : null;
}

/** Whether this reminder could have been made from a card at all. */
export function mayBeCardReminder(row: ReminderLink): boolean {
  return scanSource(row) !== null || acceptedKey(row) !== null;
}

/**
 * The family's Autopilot reminder cards whose audience is narrower than
 * everyone. Newest card first for a source, so a policy renewed every year
 * answers with this year's. Every page, so a card is never missed for being
 * old; null when the read failed.
 */
export async function readReminderCards(db: DB, familyId: string, opts: ReminderCardsOptions): Promise<ReminderCards | null> {
  const read = await readAll<ReminderCard>((from, to) => db.from('autopilot_suggestions')
    .select('id, kind, source_kind, source_id, member_id')
    .eq('family_id', familyId).eq('action_type', 'create_reminder').or(NARROWER_THAN_EVERYONE_FILTER)
    .order('created_at', { ascending: false }).order('id').range(from, to));
  if (read.error) {
    opts.onError(read.error);
    return null;
  }
  const { keyOf } = opts;
  let keys: string[] | null = null;
  if (keyOf) {
    try {
      keys = await Promise.all(read.rows.map((card) => keyOf(card.id)));
    } catch (error) {
      opts.onError(error);
      return null;
    }
  }
  const bySource = new Map<string, ReminderCard>();
  const byReminderKey = keys ? new Map<string, ReminderCard>() : null;
  read.rows.forEach((card, i) => {
    if (card.source_id && !bySource.has(card.source_id)) bySource.set(card.source_id, card);
    if (keys) byReminderKey?.set(keys[i], card);
  });
  return { bySource, byReminderKey };
}

/** `readReminderCards`, read once on first use and shared by every caller after. */
export function reminderCardsReader(db: DB, familyId: string, opts: ReminderCardsOptions): () => Promise<ReminderCards | null> {
  let read: Promise<ReminderCards | null> | null = null;
  return () => (read ??= readReminderCards(db, familyId, opts));
}

/**
 * The narrower card this reminder was made from: found, none (undefined —
 * a reminder somebody wrote, or an everyone card's), or unknown (null — an
 * accepted card's row read without `keyOf`).
 */
export function reminderCardOf(cards: ReminderCards, row: ReminderLink): ReminderCard | undefined | null {
  const source = scanSource(row);
  if (source) return cards.bySource.get(source);
  const key = acceptedKey(row);
  if (!key) return undefined;
  return cards.byReminderKey ? cards.byReminderKey.get(key) : null;
}

/**
 * Whether `viewer` may be shown this reminder. `cards` null is a failed read:
 * a reminder that could be a card's is then the managers' alone.
 */
export function reminderVisibleTo(row: ReminderLink, cards: ReminderCards | null, viewer: AudienceViewer): boolean {
  if (!mayBeCardReminder(row)) return true;
  if (!cards) return isManager(viewer.role);
  const card = reminderCardOf(cards, row);
  if (card === null) return isManager(viewer.role);
  return !card || suggestionVisibleTo(card, viewer);
}

/** The rows `viewer` may be shown; the cards are read only when a row could be a card's. */
export async function visibleReminders<T extends ReminderLink>(
  rows: T[], viewer: AudienceViewer, cards: () => Promise<ReminderCards | null>,
): Promise<T[]> {
  if (!rows.some(mayBeCardReminder)) return rows;
  const read = await cards();
  return rows.filter((row) => reminderVisibleTo(row, read, viewer));
}

/**
 * Up to `limit` rows of a reminder read that `viewer` may be shown.
 *
 * `read(n)` is the caller's query with `.limit(n)`. It is asked for `limit`
 * first — the query it always made — and asked again for twice as many only
 * while hidden rows leave this reader short and the answer was full, so a
 * guest's ten soonest are not cut to the three a read of ten leaves them. Each
 * answer is whole on its own (no page is stitched to another), and a short
 * answer ends it: the rows ran out, or the server capped the read. A failed
 * read fails, as the one query would.
 */
export async function readVisibleReminders<T extends ReminderLink, E = unknown>(
  read: (n: number) => PromiseLike<{ data: T[] | null; error: E | null }>,
  opts: { limit: number; viewer: AudienceViewer; cards: () => Promise<ReminderCards | null> },
): Promise<{ data: T[] | null; error: E | null }> {
  for (let n = opts.limit; ; n *= 2) {
    const { data, error } = await read(n);
    if (error) return { data: null, error };
    const rows = data ?? [];
    const kept = await visibleReminders(rows, opts.viewer, opts.cards);
    if (kept.length >= opts.limit || rows.length < n) return { data: kept.slice(0, opts.limit), error: null };
  }
}
