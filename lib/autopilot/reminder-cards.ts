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
// both were listed and announced to everyone.
//
// THE SCAN'S REMINDER IS FOUND BY ITS OWN ID, NOT BY ITS SOURCE. A source has
// a card per occurrence — a policy renewed every year, a passport renewed
// again — and the scan writes each occurrence's reminder before its card (the
// order that lets it remove the reminder when the card cannot be saved, and
// never announce a card whose reminder was not written). Found by its source,
// the reminder took the newest card for it, so between the two writes this
// year's renewal — meant for Ben, whose policy it now names — was classified
// by last year's card naming Ava: listed to Ava and told to her, and not to
// Ben. So the scan now saves the card with the reminder's id in its payload
// (SCAN_REMINDER_ID_KEY, lib/autopilot/scan.ts), and a 'renewal' reminder R
// for source S is answered by
//
//   1. the card that records R — R's own card, whoever it names (a card that
//      records R under another source, or two cards that both record R, are
//      no answer: unresolved);
//   2. no card for S at all: unresolved;
//   3. a card for S that records a reminder, none of them R: unresolved. That
//      is R between its commit and its card's; R after a scan whose card
//      failed to save and whose clean-up of R failed or removed nothing (R
//      outlives its card); and a reminder written before cards recorded their
//      reminder, of a source that has had a card since;
//   4. every card for S written before cards recorded their reminder: THE
//      CONSERVATIVE LEGACY RULE. Nothing on such a reminder says which of S's
//      occurrences it is, so they answer only where that cannot matter: every
//      one of S's cards has the same audience (lib/autopilot/audience.ts), and
//      it is one that admits a reader whoever the card names — everyone (a
//      refill's), or everyone but a guest (a renewal's) — and then the newest
//      decides. An insurance renewal's audience is the managers and the member
//      the policy names, which is a different member from one year's card to
//      the next, so A PRE-CHANGE INSURANCE RENEWAL REMINDER IS THE MANAGERS'
//      ALONE: never told to a member a year's card may not have named. A
//      manager still sees it, and can reassign or delete it.
//
// Its title is display text, never provenance, and nothing is inferred from
// it. A link otherwise resolves to nothing for an accepted card's key no card
// mints, beside a tag no card mints either (the card deleted, or its title,
// member or payload changed since the tag was minted), and for a row whose
// tags name two different cards; it stays with the managers, who read every
// card, rather than reaching readers its card may refuse.
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
// reminder with no link — one somebody wrote or assigned, or the scan's
// reminder for an appointment or an event, whose cards are everyone's — is
// read and addressed as before.
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
import type { Database, Json } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { readAll } from '@/lib/supabase/read-all';
import { hasReminderProvenance, reminderProvenanceTags } from '@/lib/reminders/provenance';
import { suggestionAudience, suggestionVisibleTo, type AudienceRow, type AudienceViewer, type SuggestionAudience } from '@/lib/autopilot/audience';
import { SCAN_REMINDER_ID_KEY, type SuggestionStampSource } from '@/lib/autopilot/reminder-key';
import { readKeptPrefix, type PrefixPage } from '@/lib/autopilot/visible-prefix';

type DB = SupabaseClient<Database>;

export type ReminderCard = AudienceRow & { id: string; source_id: string | null; payload?: Json };

/**
 * The family's reminder cards, whatever their audience, by the links a
 * reminder carries back to one. `byReminderKey` and `bySourceTag` are null
 * when the reader did not say how an accepted card's stamps are minted.
 */
export type ReminderCards = {
  /** Every card made from a source, newest first. */
  bySource: Map<string, ReminderCard[]>;
  /** The card that records writing this scan reminder (SCAN_REMINDER_ID_KEY); null when two cards record it. */
  byReminderId: Map<string, ReminderCard | null>;
  byReminderKey: Map<string, ReminderCard> | null;
  bySourceTag: Map<string, ReminderCard> | null;
};

/**
 * What a reminder row carries back to its card: its own id; `reminders` has
 * the source (`related_type`, `related_id`), `family_reminders` the stamps.
 */
export type ReminderLink = {
  /** The row's id: the scan's reminder is found by the card that records it. */
  id: string;
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

/** The reminder the scan recorded writing for this card (SCAN_REMINDER_ID_KEY), or null: none recorded. */
function recordedReminderId(card: ReminderCard): string | null {
  const { payload } = card;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = payload[SCAN_REMINDER_ID_KEY];
  return typeof id === 'string' && id ? id : null;
}

/**
 * Whether who may read a card of this audience depends on the member it
 * names — so that two cards of it, naming different members, may admit
 * different readers. Every audience is answered here, so one added later
 * must be.
 */
function readersDependOnMember(audience: SuggestionAudience): boolean {
  switch (audience) {
    case 'policy-readers': return true;
    case 'not-guests': return false;
    case 'everyone': return false;
  }
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
 * to be everyone's rather than unresolved. Newest card first for a source.
 * Every page, so a card is never missed for being old; null when the read
 * failed.
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
  const bySource = new Map<string, ReminderCard[]>();
  const byReminderId = new Map<string, ReminderCard | null>();
  const byReminderKey = stamps ? new Map<string, ReminderCard>() : null;
  const bySourceTag = stamps ? new Map<string, ReminderCard>() : null;
  read.rows.forEach((card, i) => {
    if (card.source_id) bySource.set(card.source_id, [...(bySource.get(card.source_id) ?? []), card]);
    const reminderId = recordedReminderId(card);
    if (reminderId) byReminderId.set(reminderId, byReminderId.has(reminderId) ? null : card);
    if (stamps) {
      byReminderKey?.set(stamps.keys[i], card);
      bySourceTag?.set(stamps.tags[i], card);
    }
  });
  return { bySource, byReminderId, byReminderKey, bySourceTag };
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
 * card failed to save, a pre-change insurance renewal's, a key and a tag no
 * card mints, tags naming two cards, or an accepted card's row read without
 * `keyOf` and `sourceTagOf`).
 *
 * The scan's reminder is found by the card that records its id (scanCard,
 * and the header's four steps). An accepted card's row is found by its key
 * first, the stamp that row was written under; then by its tag, which a next
 * occurrence carries without the key.
 */
export function reminderCardOf(cards: ReminderCards, row: ReminderLink): ReminderCard | undefined | null {
  const source = scanSource(row);
  if (source) return scanCard(cards, source, row.id);
  if (!accepted(row)) return undefined;
  const byKey = row.idempotency_key ? cards.byReminderKey?.get(row.idempotency_key) : undefined;
  return byKey ?? stampedCard(cards, row);
}

/** The card of the scan's reminder `reminderId`, made from `source`, or null: the header's four steps. */
function scanCard(cards: ReminderCards, source: string, reminderId: string): ReminderCard | null {
  // 1. The card that records this reminder, if it names the same source.
  const recorded = cards.byReminderId.get(reminderId);
  if (recorded !== undefined) return recorded?.source_id === source ? recorded : null;
  // 2. No card for the source at all.
  const made = cards.bySource.get(source) ?? [];
  if (made.length === 0) return null;
  // 3. The source's cards record their reminders, and none records this one.
  if (made.some((card) => recordedReminderId(card) !== null)) return null;
  // 4. Cards from before cards recorded their reminder: an answer only where
  //    it cannot depend on which occurrence this reminder is.
  const audience = suggestionAudience(made[0]);
  if (readersDependOnMember(audience) || made.some((card) => suggestionAudience(card) !== audience)) return null;
  return made[0];
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
 * `page(from, to)` is the caller's query with `.range(from, to)`, ordered by
 * its own keys and then by `id`, so pages neither repeat nor skip a row. It
 * is paged as the card lists are (lib/autopilot/visible-prefix.ts
 * readKeptPrefix): `limit` rows first — the read the caller always made, one
 * round trip for a reader who may be shown them all — then twice as many,
 * from where the rows returned end, while hidden rows leave this reader short;
 * until a page comes back empty, and never on a short page, which may be the
 * server's cap rather than the end: read as the end, a title lookup on a
 * server capping at one row met the managers' match first and told the
 * reader there was no reminder of theirs. A failed page fails, as the one
 * query would.
 */
export async function readVisibleReminders<T extends ReminderLink, E = unknown>(
  page: PrefixPage<T, E>,
  opts: { limit: number; viewer: AudienceViewer; cards: () => Promise<ReminderCards | null> },
): Promise<{ data: T[] | null; error: E | null }> {
  return readKeptPrefix(page, opts.limit, (rows) => visibleReminders(rows, opts.viewer, opts.cards));
}
