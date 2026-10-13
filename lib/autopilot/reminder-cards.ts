// Reminder visibility requires the database's immutable origin metadata.
// Deploy the origin migration first. Missing schema/read failures call onError
// and fail closed; public keys, tags and payloads grant no audience. Both tables
// are read because existing consumers omit origin columns from their projection.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { readAll } from '@/lib/supabase/read-all';
import { suggestionVisibleTo, type AudienceRow, type AudienceViewer } from '@/lib/autopilot/audience';
import { SCAN_REMINDER_ID_KEY, type SuggestionStampSource } from '@/lib/autopilot/reminder-key';
import { readKeptPrefix, type PrefixPage } from '@/lib/autopilot/visible-prefix';

type DB = SupabaseClient<Database>;
type ReminderOrigin = {
  id: string;
  family_id: string;
  autopilot_origin: boolean;
  autopilot_card_id: string | null;
};

export type ReminderCard = AudienceRow & { id: string; family_id?: string | null; source_id: string | null; payload?: Json };

/** The family's trusted reminder origins and cards, with legacy compatibility indexes. */
export type ReminderCards = {
  /** Every card made from a source, newest first. */
  bySource: Map<string, ReminderCard[]>;
  /** Trusted metadata from both tables; duplicate IDs are unresolved. */
  byReminderOrigin?: Map<string, ReminderOrigin | null>;
  byCardId?: Map<string, ReminderCard>;
  familyId?: string;
  /** The card that records writing this scan reminder (SCAN_REMINDER_ID_KEY); null when two cards record it. */
  byReminderId: Map<string, ReminderCard | null>;
  byReminderKey: Map<string, ReminderCard> | null;
  bySourceTag: Map<string, ReminderCard> | null;
};

/** Existing projections may omit immutable origin fields; only the DB map supplies them. */
export type ReminderLink = {
  /** The row's id resolves its immutable origin in the family-scoped DB map. */
  id: string;
  family_id?: string | null;
  related_type?: string | null;
  related_id?: string | null;
  idempotency_key?: string | null;
  tags?: string[] | null;
};

/** Compatibility stamp indexes preserve existing mint/read error semantics. */
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
  /** Told when cards, origin metadata or stamp mints fail; the reader answers null. */
  onError: (error: unknown) => void;
};

/** The reminder the scan recorded writing for this card (SCAN_REMINDER_ID_KEY), or null: none recorded. */
function recordedReminderId(card: ReminderCard): string | null {
  const { payload } = card;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = payload[SCAN_REMINDER_ID_KEY];
  return typeof id === 'string' && id ? id : null;
}

/** A projection cannot establish that a row is manual; every row needs metadata. */
export function mayBeCardReminder(_row: ReminderLink): boolean {
  return true;
}

/** Immutable family origins, independent of unrelated card availability. */
async function readReminderOrigins(db: DB, familyId: string, opts: ReminderCardsOptions): Promise<Map<string, ReminderOrigin | null> | null> {
  const origins = await Promise.all([
    readAll<ReminderOrigin>((from, to) => db.from('family_reminders')
      .select('id, family_id, autopilot_origin, autopilot_card_id')
      .eq('family_id', familyId).order('id').range(from, to)),
    readAll<ReminderOrigin>((from, to) => db.from('reminders')
      .select('id, family_id, autopilot_origin, autopilot_card_id')
      .eq('family_id', familyId).order('id').range(from, to)),
  ]);
  const byReminderOrigin = new Map<string, ReminderOrigin | null>();
  for (const originRead of origins) {
    if (originRead.error) {
      opts.onError(originRead.error);
      return null;
    }
    for (const origin of originRead.rows) {
      if (!origin.id || origin.family_id !== familyId ||
          typeof origin.autopilot_origin !== 'boolean' ||
          (origin.autopilot_card_id !== null && typeof origin.autopilot_card_id !== 'string') ||
          (!origin.autopilot_origin && origin.autopilot_card_id !== null)) {
        opts.onError(new Error('Trusted reminder origin metadata is unavailable or inconsistent; deploy the origin schema first.'));
        return null;
      }
      // An ID collision between the two tables must not choose an audience.
      byReminderOrigin.set(origin.id, byReminderOrigin.has(origin.id) ? null : origin);
    }
  }
  return byReminderOrigin;
}

/**
 * Every Autopilot card of the family's that a reminder can be made from — the
 * ones whose audience is everyone too, so that a link to one of them is known
 * to be everyone's rather than unresolved. Newest card first for a source.
 * Every page, so a card is never missed for being old; null when the read
 * failed.
 */
export async function readReminderCards(db: DB, familyId: string, opts: ReminderCardsOptions): Promise<ReminderCards | null> {
  return readReminderCardsWithOrigins(db, familyId, opts);
}

/** Trusted maps here are supplied only by this module's database loader. */
async function readReminderCardsWithOrigins(
  db: DB, familyId: string, opts: ReminderCardsOptions,
  trustedOrigins?: Map<string, ReminderOrigin | null>,
): Promise<ReminderCards | null> {
  // The audience and the links, and what the card's tag is minted from.
  const read = await readAll<ReminderCard & SuggestionStampSource>((from, to) => db.from('autopilot_suggestions')
    .select('id, family_id, kind, source_kind, source_id, member_id, action_type, title, detail, urgency, payload')
    .eq('family_id', familyId).eq('action_type', 'create_reminder')
    .order('created_at', { ascending: false }).order('id').range(from, to));
  if (read.error) {
    opts.onError(read.error);
    return null;
  }
  // The immutable database columns are the authority when callers select only
  // id/title too. Ordinary reads obey RLS; service reads apply the viewer below.
  // Deploy the origin schema first. Missing columns never enable legacy access.
  const byReminderOrigin = trustedOrigins ?? await readReminderOrigins(db, familyId, opts);
  if (!byReminderOrigin) return null;
  const byCardId = new Map<string, ReminderCard>();
  for (const card of read.rows) {
    if (card.family_id === familyId) byCardId.set(card.id, card);
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
  return { bySource, byReminderId, byReminderKey, bySourceTag, byReminderOrigin, byCardId, familyId };
}

/** Existing zero-argument readers remain valid; the factory may use requested rows. */
export type ReminderCardsReader = (rows?: readonly ReminderLink[]) => Promise<ReminderCards | null>;

/**
 * Fetch immutable origins first. A request proved entirely manual needs neither
 * cards nor stamp mints. Its shell must never stand in for a later full read.
 */
export function reminderCardsReader(db: DB, familyId: string, opts: ReminderCardsOptions): ReminderCardsReader {
  let origins: Promise<Map<string, ReminderOrigin | null> | null> | null = null;
  let fullRead: Promise<ReminderCards | null> | null = null;
  let manual: ReminderCards | null = null;
  return async (rows) => {
    const metadata = await (origins ??= readReminderOrigins(db, familyId, opts));
    if (!metadata) return null;
    const onlyManual = rows !== undefined && rows.length > 0 && rows.every((row) => {
      const origin = metadata.get(row.id);
      return origin?.family_id === familyId && origin.autopilot_origin === false &&
        origin.autopilot_card_id === null && (row.family_id == null || row.family_id === familyId);
    });
    if (onlyManual) {
      return (manual ??= {
        bySource: new Map(), byReminderId: new Map(), byReminderKey: null, bySourceTag: null,
        byReminderOrigin: metadata, byCardId: new Map(), familyId,
      });
    }
    return (fullRead ??= readReminderCardsWithOrigins(db, familyId, opts, metadata));
  };
}
/**
 * Only the database origin identifies a generated reminder's card. Public
 * stamps and display payloads remain compatibility indexes, never authority.
 * Missing/deleted/historical origins remain unresolved for ordinary viewers.
 */
export function reminderCardOf(cards: ReminderCards, row: ReminderLink): ReminderCard | undefined | null {
  const origin = cards.byReminderOrigin?.get(row.id);
  if (!origin || !cards.familyId || origin.family_id !== cards.familyId ||
      (row.family_id != null && row.family_id !== origin.family_id)) return null;
  if (origin.autopilot_origin === false) return origin.autopilot_card_id === null ? undefined : null;
  if (origin.autopilot_origin !== true) return null;
  if (!origin.autopilot_card_id) return null;
  const card = cards.byCardId?.get(origin.autopilot_card_id);
  return card && card.id === origin.autopilot_card_id && card.family_id === origin.family_id ? card : null;
}

/**
 * Whether `viewer` may be shown this reminder. A linked one goes past the
 * managers only when its card is found and admits the viewer: `cards` null
 * (a failed read) and an unresolved link leave it the managers' alone.
 */
export function reminderVisibleTo(row: ReminderLink, cards: ReminderCards | null, viewer: AudienceViewer): boolean {
  // A known foreign-family row is refused even for managers. Failed reads have
  // no trusted family metadata: consumers must handle onError before using the
  // conservative manager-only result, especially before any manager write.
  if (row.family_id != null && cards?.familyId && row.family_id !== cards.familyId) return false;
  const card = cards ? reminderCardOf(cards, row) : null;
  if (card === undefined) return true;
  if (card === null) return isManager(viewer.role);
  return suggestionVisibleTo(card, viewer);
}

/** Resolve every nonempty projection through trusted metadata for this viewer. */
export async function visibleReminders<T extends ReminderLink>(
  rows: T[], viewer: AudienceViewer, cards: ReminderCardsReader,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const read = await cards(rows);
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
  opts: { limit: number; viewer: AudienceViewer; cards: ReminderCardsReader },
): Promise<{ data: T[] | null; error: E | null }> {
  return readKeptPrefix(page, opts.limit, (rows) => visibleReminders(rows, opts.viewer, opts.cards));
}
