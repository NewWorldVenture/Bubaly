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
// card is not for.
//
// A LINK THAT FINDS NO CARD IS THE MANAGERS' ALONE. Only a card positively
// found widens a linked reminder past them, so every card a reminder can be
// made from is read — the everyone cards too (a refill's "Refill a
// prescription", an appointment's) — and not only the narrower ones: read that
// way, a broad card and a link that resolves to nothing looked the same, and
// both were listed and announced to everyone. A link resolves to nothing
//
//   - between the scan's two writes. It commits the reminder first and its
//     card second (the order that lets it remove the reminder when the card
//     cannot be saved, and never announce a card whose reminder was not
//     written), so a reader or a notification tick in between found the
//     policy's reminder and no card: a guest was listed it, and the whole
//     family was told it;
//   - after a scan whose card failed to save and whose clean-up of the
//     reminder failed or removed nothing: the reminder outlives its card;
//   - for a legacy or ambiguous link: a 'renewal' reminder whose card has
//     since been deleted; an accepted card's key no card mints, beside a tag
//     no card mints either (the card deleted, or its title, member or payload
//     changed since the tag was minted); a row whose tags name two different
//     cards. Nothing else on such a row says whose it is — its title is
//     display text, never provenance — so it stays with the managers, who
//     read every card, rather than reaching readers its card may refuse. A
//     manager still sees it, and can reassign or delete it.
//
// An accepted card's row carries two stamps, and either finds its card: the
// key (`idempotency_key`) is that one row's, and the tag (AUTOPILOT_SOURCE_TAG,
// a sha-256 of the card's own identity and content) travels with the tags onto
// the next occurrence of a repeating one, which the reminders module and the
// assistant's complete_reminder write without a key. Read by the key alone,
// the next occurrence of Kit's refill — a card for everyone, assigned to him —
// was listed to the managers and told to them, and Kit never heard of his own
// reminder.
//
// A failed read of the cards is the same answer for every linked reminder. A
// reminder with no link — one somebody wrote, or the scan's reminder for an
// appointment or an event, whose cards are everyone's — is read and addressed
// as before.
//
// Nor does a card the reader cannot find. Under 0486 a reader reads only the
// cards that are theirs (the RLS twin of lib/autopilot/audience.ts), so a
// guest's read of the cards has no renewal card in it and an unnamed teen's no
// insurance card; answered as "no card", their reminders reached exactly the
// readers the card refuses. So every create_reminder card the reader may read
// is read, an everyone card's (a refill's, also related_type 'renewal')
// included, and a reminder that looks like a card's whose card is not among
// them is the managers' — who read every card, so it is never theirs to miss.
// The same answer holds before 0486, when every member reads every card and an
// unfound card is one that was never written.
//
// Client-safe: the briefing module's kitchen list, the Health page and the
// reminders module read their reminders in the browser. The stamps an
// accepted card writes are sha-256s (suggestionReminderKey,
// suggestionSourceTag), so a reader of `family_reminders` passes their mints
// in as `keyOf` and `sourceTagOf` — the server's, or the browser's
// (lib/autopilot/reminder-key.ts); without them such a row is unresolved,
// never nobody's card.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { readAll } from '@/lib/supabase/read-all';
import { hasReminderProvenance, reminderProvenanceTags } from '@/lib/reminders/provenance';
import { suggestionVisibleTo, type AudienceRow, type AudienceViewer } from '@/lib/autopilot/audience';
import type { SuggestionStampSource } from '@/lib/autopilot/reminder-key';

type DB = SupabaseClient<Database>;

export type ReminderCard = AudienceRow & { id: string; source_id: string | null };

/**
 * The family's reminder cards, whatever their audience, by the three links a
 * reminder carries back to one. `byReminderKey` and `bySourceTag` are null
 * when the reader did not say how an accepted card's stamps are minted.
 */
export type ReminderCards = {
  bySource: Map<string, ReminderCard>;
  byReminderKey: Map<string, ReminderCard> | null;
  bySourceTag: Map<string, ReminderCard> | null;
};

/** What a reminder row carries back to its card: `reminders` has the first two, `family_reminders` the last two. */
export type ReminderLink = {
  related_type?: string | null;
  related_id?: string | null;
  idempotency_key?: string | null;
  tags?: string[] | null;
};

/**
 * How an accepted card's two stamps are minted, both or neither: a reader of
 * `family_reminders` that resolved the key alone would leave every next
 * occurrence of a repeating one with the managers.
 */
type StampMints =
  | {
    /**
     * The card's reminder key: lib/services/autopilot suggestionReminderKey on
     * the server, lib/autopilot/reminder-key.ts mintSuggestionReminderKey in
     * the browser. A mint that fails is a failed read.
     */
    keyOf: (cardId: string) => string | PromiseLike<string>;
    /**
     * The card's tag: lib/services/autopilot suggestionSourceTag on the
     * server, lib/autopilot/reminder-key.ts mintSuggestionSourceTag in the
     * browser. A mint that fails is a failed read.
     */
    sourceTagOf: (card: SuggestionStampSource) => string | PromiseLike<string>;
  }
  | { keyOf?: undefined; sourceTagOf?: undefined };

export type ReminderCardsOptions = StampMints & {
  /** Told when the cards could not be read; the reader then answers null. */
  onError: (error: unknown) => void;
};

/** The source a scan-made reminder names (lib/autopilot/scan.ts relatedType), or null. */
function scanSource(row: ReminderLink): string | null {
  return row.related_type === 'renewal' && row.related_id ? row.related_id : null;
}

/**
 * Whether this row carries the stamp an accepted card writes: the exact one
 * resolveSuggestion makes (lib/reminders/provenance.ts), not any tag that only
 * starts like it. A person's own "autopilot-source:notes" is a tag, and their
 * reminder stays theirs.
 */
function accepted(row: ReminderLink): boolean {
  return hasReminderProvenance(row.tags);
}

/** Whether this reminder carries a link back to a card at all. */
export function mayBeCardReminder(row: ReminderLink): boolean {
  return scanSource(row) !== null || accepted(row);
}

/**
 * Every Autopilot card of the family's that a reminder can be made from — the
 * ones whose audience is everyone too, so that a link to one of them is known
 * to be everyone's rather than unresolved. Newest card first for a source, so
 * a policy renewed every year answers with this year's. Every page, so a card
 * is never missed for being old; null when the read failed.
 */
export async function readReminderCards(db: DB, familyId: string, opts: ReminderCardsOptions): Promise<ReminderCards | null> {
  // The audience and the links, and what the card's tag is minted from.
  const read = await readAll<ReminderCard & SuggestionStampSource>((from, to) => db.from('autopilot_suggestions')
    .select('id, family_id, kind, source_kind, source_id, member_id, action_type, title, detail, urgency, payload')
    .eq('family_id', familyId).eq('action_type', 'create_reminder')
    .order('created_at', { ascending: false }).order('id').range(from, to));
  if (read.error) {
    opts.onError(read.error);
    return null;
  }
  const { keyOf, sourceTagOf } = opts;
  let stamps: { keys: string[]; tags: string[] } | null = null;
  if (keyOf && sourceTagOf) {
    try {
      const [keys, tags] = await Promise.all([
        Promise.all(read.rows.map((card) => keyOf(card.id))),
        Promise.all(read.rows.map((card) => sourceTagOf(card))),
      ]);
      stamps = { keys, tags };
    } catch (error) {
      opts.onError(error);
      return null;
    }
  }
  const bySource = new Map<string, ReminderCard>();
  const byReminderKey = stamps ? new Map<string, ReminderCard>() : null;
  const bySourceTag = stamps ? new Map<string, ReminderCard>() : null;
  read.rows.forEach((card, i) => {
    if (card.source_id && !bySource.has(card.source_id)) bySource.set(card.source_id, card);
    if (stamps) {
      byReminderKey?.set(stamps.keys[i], card);
      bySourceTag?.set(stamps.tags[i], card);
    }
  });
  return { bySource, byReminderKey, bySourceTag };
}

/** `readReminderCards`, read once on first use and shared by every caller after. */
export function reminderCardsReader(db: DB, familyId: string, opts: ReminderCardsOptions): () => Promise<ReminderCards | null> {
  let read: Promise<ReminderCards | null> | null = null;
  return () => (read ??= readReminderCards(db, familyId, opts));
}

/**
 * The card this reminder was made from: found, whatever its audience; no link
 * at all (undefined — a reminder somebody wrote); or unresolved (null — a link
 * no card answers: the scan's reminder before its card is saved or after the
 * card failed to save, a key and a tag no card mints, tags naming two cards,
 * or an accepted card's row read without `keyOf` and `sourceTagOf`).
 *
 * An accepted card's row is found by its key first, the stamp that row was
 * written under; then by its tag, which a next occurrence carries without
 * the key.
 */
export function reminderCardOf(cards: ReminderCards, row: ReminderLink): ReminderCard | undefined | null {
  const source = scanSource(row);
  if (source) return cards.bySource.get(source) ?? null;
  if (!accepted(row)) return undefined;
  const byKey = row.idempotency_key ? cards.byReminderKey?.get(row.idempotency_key) : undefined;
  return byKey ?? stampedCard(cards, row);
}

/** The one card this row's tags name, or null: none does, or they name two. */
function stampedCard(cards: ReminderCards, row: ReminderLink): ReminderCard | null {
  const { bySourceTag } = cards;
  if (!bySourceTag) return null;
  const named = new Set(reminderProvenanceTags(row.tags).flatMap((tag) => bySourceTag.get(tag) ?? []));
  return named.size === 1 ? [...named][0] : null;
}

/**
 * Whether `viewer` may be shown this reminder. A linked one goes past the
 * managers only when its card is found and admits the viewer: `cards` null
 * (a failed read) and an unresolved link leave it the managers' alone.
 */
export function reminderVisibleTo(row: ReminderLink, cards: ReminderCards | null, viewer: AudienceViewer): boolean {
  if (!mayBeCardReminder(row)) return true;
  const card = cards ? reminderCardOf(cards, row) : null;
  if (!card) return isManager(viewer.role);
  return suggestionVisibleTo(card, viewer);
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
