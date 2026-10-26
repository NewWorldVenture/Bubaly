// lib/notifications/fair-batch.ts — how push and email dispatch share a batch.
// Pure: no Supabase or provider calls of its own, so it stays unit testable.
//
// WHY. Push (lib/server/push.ts) and the email digest
// (lib/server/notification-emails.ts) each take a bounded batch of pending
// notifications in created_at order: 200 rows a tick for push, 500 a day for
// email. A member's session may still INSERT a notification addressed to
// themselves (0388's notif_insert: is_family_member(family_id) and
// user_id = auth.uid()), with any number of rows and any created_at, send_at,
// pushed_at or sent_at, because no column grant or trigger pins them. No
// writer in the application needs that insert: notify() writes with the
// service role, and so do the guardian, escalation, contact-centre and
// generator writers. Until the policy is dropped (an owner action), a child
// could fill every batch with rows of their own, dated 1970 so they sort first,
// and hold back every family's pushes and every digest until the flood drained,
// and plant more the next day.
//
// A member can also CAUSE whole-family rows (user_id null), in their own
// family and in every family watching a listing of theirs: 0191's
// marketplace_log_price_change (SECURITY DEFINER, after update of price_cents)
// writes one, related_type 'marketplace_listings' and related_id the listing,
// into EACH family that saved the listing on every price drop, with no dedupe
// or throttle, and the listing's owner may PATCH its price up and down at
// will. So the family a price drop lands in is not the one that caused it:
// counted against its receiving family, one seller's drops across twenty
// watcher families took twenty family shares, the whole batch, and in the
// seller's own family they took the family's own whole-family share, so its
// 'Family dinner at 6' queued behind them. Counted by listing alone (round
// 9), one family's own listings took one share EACH: 0154 lets any member
// create listings, save them in their own family and re-price them at will,
// so a child's twenty listings, watched by nobody else, took every batch once
// nobody else was waiting, ahead of every other family's price drops, about
// 200 rows a tick for as long as their backlog lasted.
//
// WHAT THIS BOUNDS. A batch is shared by FAMILY first: no family takes more
// than `perFamily` rows while another family's rows are waiting in the range,
// whether those rows are addressed to members or to the whole family. Inside
// a family it is shared by recipient, the family's whole-family rows counting
// as one more recipient: no one of them takes more than `perRecipient` rows
// while anyone else's are waiting, so a child's flood of their own rows does
// not hold back a parent's row either. Price drops (isMarketplaceNotice) are
// no family's: they are shared as one family of their own, the marketplace,
// whichever family they land in, and inside it by SELLER (sellerOf: the
// family whose listing it is) and by LISTING, a drop counting against both
// and taken only while both have room. So while anyone else waits, one
// family's listings together take one recipient's share however many
// listings it has and however many families saved them, one listing across
// any number of watcher families takes one share, and a price drop takes none
// of the share of the family it lands in. Only when nobody else is waiting
// does a family's surplus, and then a recipient's, fill the room left: a lone
// family's backlog, a lone seller's included, still goes out a full batch at
// a time. An attacker holding several families still takes that many family
// shares; this bounds the damage, and dropping the policy (and throttling the
// trigger, both owner actions) is what ends it. A seller's share holds as far
// as a read can reach past the drops it holds back (the seller paragraph
// below): behind more of those than that, another seller's drop waits for the
// surplus.
//
// A drop whose listing is not found (deleted since: 0154 lets its owner delete
// it, and its drops stay, related_id being text with no foreign key; or the
// lookup failed) has no known seller. It is not counted against the family it
// landed in, which is a watcher's as often as the seller's own: the drops not
// found that landed in one family share one recipient's share of their own,
// which no seller's drops share, and all the drops not found together take no
// more than one family's share, so a seller whose listings are gone does not
// get one share back for each family its drops landed in.
//
// A seller is not a column of the notification, so a read cannot leave a full
// seller's drops out by seller. It names the narrowest thing it can: the
// family a drop landed in when that is the seller's own (a member's own
// listings saved in their own family, which needs nobody else), else the
// listing. So that the names stay bounded, a full seller's listings landing in
// other families are named one by one up to `size / perRecipient` of them,
// then the families they land in up to as many again. Past both, a full
// seller's further drops still wait, unnamed: the read cannot leave them out
// and returns them again, so it is asked for FAIR_READ_MAX_ROWS rows to reach
// past them, and once a read that far is filled by rows already taken or held
// back, the marketplace is left out of the rest of the shared passes, so every
// family's own rows behind them are still reached. (Until round 14 such a
// drop counted against its own listing's share alone, and one seller's drops
// across more listings and families than the names hold filled the batch
// ahead of another seller's.) The bound: over one range (push's first run,
// with no cursor yet), a row is reached in the shared passes while fewer than
// FAIR_READ_MAX_ROWS rows not left out come before it, those already taken
// (fewer than `size`) among them; so whenever at most FAIR_READ_MAX_ROWS - size
// held-back drops come before it, 800 at push's batch of 200. Push's later
// runs split each read between the rows behind the cursor and those ahead
// (aheadAndBehind, a quarter for the retries behind), so while both ranges
// fill their part, a read that far reaches 750 rows ahead of the cursor and
// 250 behind it, the rows taken in each among them. Behind more, another
// seller's drop waits for the surplus, which takes the flood ahead of it a
// batch at a time, in created_at order. (The email digest reads no
// whole-family row, so no price drop.) Full drops not found are named
// the same way from names of their own, not the known sellers': by listing
// while the family they landed in has named fewer than `size / perRecipient`
// listings and all of them together fewer than twice that, then by that family,
// up to `size / perRecipient` families. A family's own deleted listings look
// like a watcher's, so they spend none of the known sellers' names and no more
// than half of the listing names kept for drops not found: the rest is left
// for the families that saved some of its other listings, live or deleted. A
// read so names at most 4 * size / perRecipient listings and 3 * size /
// perRecipient landing families, the full listings and the sellers' own
// families among them (the shares above hold at most size / perRecipient of
// each). A family named so has every price drop into it wait, other sellers'
// too, until the room left after everyone else's: one family that saved more
// of a full seller's listings than a batch has shares is enough for that,
// whether those listings are still there or not.
//
// Push sends every id a read leaves out in the read's URL, 39 bytes an id, and
// past the gateway's request-line limit (nginx's 8,192 bytes) the read fails
// and no family gets a push. At push's shares the most the bound above allows,
// counted kind by kind (5 families, 20 recipients, 80 listings, 60 landing
// families: 165 ids, an over-count, since the listings at their own share are
// among the 20 share holders), builds a request line of 7,855 bytes, in a
// family-scoped read behind the cursor asking for FAIR_READ_MAX_ROWS rows
// (7,854 at a batch's 200: only the limit's digits differ); the names round 12
// added cost 2,340 bytes of that. A flood that fills every pool came to 4,785.
// tests/the-most-a-push-read-leaves-out-fits-its-request-line.test.ts measures
// both through push and supabase-js and holds each pool at its size, so a
// wider pool fails there first.
//
// Rows dated after now (beyond a clock-skew allowance) are not read at all, by
// either dispatcher: no writer sets created_at, which defaults to now(), so
// such a row can only be planted, and one dated in the future sat outside the
// push retry window for ever.

/** The allowance for the app host's clock against the database's when windowing on created_at. */
export const NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The latest created_at a pending notification may carry and still be read, as an ISO instant. */
export function latestCreatedAt(now: Date): string {
  return new Date(now.getTime() + NOTIFICATION_CLOCK_SKEW_MS).toISOString();
}

/**
 * The value list of a PostgREST `in` filter over recipient or family ids. The
 * ids come from uuid columns, so anything outside letters, digits, `_` and `-`
 * is not one and would be filter syntax: refused rather than interpolated.
 */
export function recipientList(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Notification recipient id is not a key.');
  }
  return `(${ids.join(',')})`;
}

/**
 * A pending notification as the batch shares it out. A reader that reads
 * whole-family rows (user_id null) selects related_type and related_id too,
 * so a price drop is told apart (isMarketplaceNotice), and gives a price drop
 * the family of the listing it names (marketplace_listings.family_id) as
 * `seller_family_id`, or null when the listing is not found.
 */
export type FairRow = {
  id: string; family_id: string; user_id: string | null;
  related_type?: string | null; related_id?: string | null;
  seller_family_id?: string | null;
};

/** The related_type of the whole-family rows 0191's price-drop trigger writes, related_id the listing. */
export const MARKETPLACE_RELATED_TYPE = 'marketplace_listings';

/**
 * Whether a row is a marketplace notice to a whole family: 0191's price drops,
 * the only writer of a whole-family row about a listing. (An auction's
 * 'reserve not met' is not one: app/api/cron/close-auctions writes it through
 * notify(), one row per member with user_id set, and it is shared as theirs.)
 * A member of another family can cause any number of them, so they are shared
 * as one family of their own and, inside it, by seller and by listing, not as
 * rows of the family that receives them. Those that name no listing (no
 * writer leaves related_id null) are still the marketplace's, and share one
 * listing's share between them.
 */
export function isMarketplaceNotice(row: FairRow): boolean {
  return !row.user_id && row.related_type === MARKETPLACE_RELATED_TYPE;
}

/**
 * The family a price drop counts against inside the marketplace: the family
 * whose listing it is, as the reader resolved it, or null when the listing was
 * not found (deleted since, or the lookup failed). A drop not found is not
 * counted against the family it landed in (readFairBatch: it shares the drops
 * not found of that family, and of every family together, instead).
 */
export function sellerOf(row: FairRow): string | null {
  return row.seller_family_id || null;
}

/** What one read of a range leaves out. */
export type FairExclusion = {
  /** Every row of these families, the marketplace notices that land in them included. */
  readonly families: readonly string[];
  /** Rows addressed to these users. */
  readonly recipients: readonly string[];
  /** The whole-family rows (user_id null) of these families, but not their marketplace notices. */
  readonly familyWide: readonly string[];
  /** Every marketplace notice (isMarketplaceNotice), whichever family it landed in. */
  readonly marketplace: boolean;
  /** The marketplace notices about these listings (related_id), whichever family they landed in. */
  readonly listings: readonly string[];
  /** The marketplace notices that landed in these families (a full seller's, see readFairBatch). */
  readonly landing: readonly string[];
  /** The marketplace notices that name no listing (related_id null). */
  readonly unlisted: boolean;
};

/**
 * The most rows readFairBatch asks one read for: PostgREST's db-max-rows, 1,000
 * on a default project (lib/supabase/read-all.ts), so a read that asks this
 * many and gets fewer has reached the end of its range, not the server's cap.
 * A read asks for more than the room left only to reach past the price drops
 * it holds back without a name (the header's seller paragraph).
 */
export const FAIR_READ_MAX_ROWS = 1000;

/** How much of a batch one family, and one recipient inside it, takes while anyone else's rows are waiting. */
export type FairShares = { readonly perFamily: number; readonly perRecipient: number };

/**
 * `read(size, excluded)` returns the next `size` pending rows of ONE range in
 * the dispatcher's order, leaving out every row `excluded` names.
 */
export type FairRead<T extends FairRow> = (size: number, excluded: FairExclusion) => Promise<T[]>;

const NOTHING: FairExclusion = {
  families: [], recipients: [], familyWide: [], marketplace: false, listings: [], landing: [], unlisted: false,
};

/** Whether `excluded` leaves this row out. */
export function isExcluded(excluded: FairExclusion, row: FairRow): boolean {
  if (excluded.families.includes(row.family_id)) return true;
  if (row.user_id) return excluded.recipients.includes(row.user_id);
  if (isMarketplaceNotice(row)) {
    return excluded.marketplace || excluded.landing.includes(row.family_id)
      || (row.related_id ? excluded.listings.includes(row.related_id) : excluded.unlisted);
  }
  return excluded.familyWide.includes(row.family_id);
}

function isNothing(excluded: FairExclusion): boolean {
  return !excluded.families.length && !excluded.recipients.length && !excluded.familyWide.length
    && !excluded.marketplace && !excluded.listings.length && !excluded.landing.length && !excluded.unlisted;
}

/** Whether every row `narrower` leaves out, `wider` leaves out too. */
function within(narrower: FairExclusion, wider: FairExclusion): boolean {
  return narrower.families.every((id) => wider.families.includes(id))
    && narrower.recipients.every((id) => wider.recipients.includes(id))
    && narrower.familyWide.every((id) => wider.familyWide.includes(id))
    && (!narrower.marketplace || wider.marketplace)
    && narrower.listings.every((id) => wider.listings.includes(id))
    && narrower.landing.every((id) => wider.landing.includes(id))
    && (!narrower.unlisted || wider.unlisted);
}

/**
 * Read one batch of up to `size` rows, fairly by family and, inside a family,
 * by recipient (its whole-family rows counting as one recipient). The
 * marketplace notices are one family more, shared inside it by seller and by
 * listing, a drop counting against both; a drop whose listing was not found
 * counts against the drops not found of the family it landed in, and of every
 * family together, in place of a seller.
 *
 * Rows are taken in the order the reads return them and never given back. In
 * the first pass a row is taken only while its family is under `perFamily`
 * and its recipient under `perRecipient`; a family or recipient that reaches
 * its share is left out of every later read, which starts again from the top
 * of the range and asks for the room left plus the rows already taken that it
 * will return again; or, once a full seller's drop is held back with no name
 * left to leave it out by, for FAIR_READ_MAX_ROWS, to reach past those (the
 * header's seller paragraph). When a read comes back short, nobody but those
 * left out or held back has a row waiting, and the next pass lifts one level:
 * the family shares first (so a parent's row in a family a flood filled is
 * reached, still shared by recipient), then everything (the surplus, in
 * order). A pass whose exclusions are the ones the last short read already
 * used is skipped, so a batch nobody floods is one read. Each round leaves out
 * at least one more family or recipient (the marketplace, its listings and its
 * sellers' landing families among them), each holding a full share of the
 * batch, or one more listing or landing family named for a full seller or for
 * full drops not found, of which a batch names at most 3 * size / perRecipient
 * listings and 2 * size / perRecipient landing families (the header). So the
 * rounds are bounded (size / perFamily + 7 * size / perRecipient, plus one a
 * pass, the marketplace, and two for the drops held back with no name: the
 * first read that reaches past them, and the one that leaves the marketplace
 * out once a read that far is filled), and so is the exclusion list. Every
 * read happens before anything is sent. Rows come back in the order they were
 * taken, not re-sorted: a caller that needs its order sorts them.
 */
export async function readFairBatch<T extends FairRow>(read: FairRead<T>, size: number, shares: FairShares): Promise<T[]> {
  if (!Number.isInteger(size) || size < 1) return [];
  const { perFamily, perRecipient } = shares;
  if (!Number.isInteger(perRecipient) || perRecipient < 1 || !Number.isInteger(perFamily) || perFamily < perRecipient) {
    throw new Error('A batch share must be a positive integer, and a family\'s no smaller than a recipient\'s.');
  }
  const taken = new Map<string, T>();
  const byFamily = new Map<string, number>();
  const byRecipient = new Map<string, number>();
  const fullFamilies = new Set<string>();
  const fullRecipients = new Set<string>();
  const fullFamilyWide = new Set<string>();
  const fullListings = new Set<string>();
  const fullLanding = new Set<string>();
  const bySeller = new Map<string, number>();
  // The drops not found taken so far, every family's together (the header).
  let notFoundTaken = 0;
  let marketplaceFull = false;
  let unlistedFull = false;
  // How many of full sellers' listings, and then landing families, a read
  // has been asked to leave out by name (the header's seller paragraph). The
  // known sellers' drops and the drops not found count theirs apart, and the
  // drops not found also by the family they landed in, so that neither, nor
  // one family's own deleted listings, spends the names another needs.
  const named = Math.ceil(size / perRecipient);
  const names = {
    known: { listings: 0, landing: 0, maxListings: named },
    notFound: { listings: 0, landing: 0, maxListings: 2 * named },
  };
  const notFoundListingsBy = new Map<string, number>();
  // A full seller's drops that no name is left for (leaveOutSeller): they
  // still wait, but a read cannot leave them out, so it returns them again,
  // and from then on asks for FAIR_READ_MAX_ROWS rows to reach past them.
  // Once a read that far is filled by rows already taken or held, the
  // marketplace is left out instead, so the rows of every family behind them
  // are still reached (the header's seller paragraph).
  const held = new Set<string>();
  let marketplaceOutOfReach = false;
  // The shares a row counts against, as isExcluded leaves it out: a price
  // drop against the marketplace, its listing and its seller, whichever
  // family it landed in.
  const familyOf = (row: T) => (isMarketplaceNotice(row) ? 'marketplace' : `family:${row.family_id}`);
  const recipientOf = (row: T) => (row.user_id ? `user:${row.user_id}`
    : isMarketplaceNotice(row) ? `listing:${row.related_id ?? ''}` : `family:${row.family_id}`);
  // A drop's seller share: its seller's, or, when its listing was not found,
  // the share of the drops not found that landed in the same family, which no
  // seller's drops share.
  const sellerShareOf = (row: T) => {
    const seller = sellerOf(row);
    return seller ? `seller:${seller}` : `not-found:${row.family_id}`;
  };
  /**
   * Leave a full seller's drop out by the narrowest name a read can carry:
   * the family it landed in when that is the seller's own, else its listing,
   * else (past `named` listings) the family it landed in. False once those
   * names are spent: the drop still waits, held back by the pass. A drop
   * not found has no seller, so the family it landed in is never taken for its
   * seller's own: it is named once that family's drops not found have named
   * `named` listings, or all of them together twice that, and its listing
   * names come from their own count, not the known sellers'.
   */
  const leaveOutSeller = (row: T): boolean => {
    const seller = sellerOf(row);
    if (row.family_id === seller) { fullLanding.add(row.family_id); return true; }
    const pool = seller ? names.known : names.notFound;
    const byLanding = seller ? 0 : notFoundListingsBy.get(row.family_id) ?? 0;
    if (row.related_id && (fullListings.has(row.related_id) || (pool.listings < pool.maxListings && byLanding < named))) {
      if (!fullListings.has(row.related_id)) {
        fullListings.add(row.related_id);
        pool.listings += 1;
        if (!seller) notFoundListingsBy.set(row.family_id, byLanding + 1);
      }
      return true;
    }
    if (fullLanding.has(row.family_id) || pool.landing < named) {
      if (!fullLanding.has(row.family_id)) { fullLanding.add(row.family_id); pool.landing += 1; }
      return true;
    }
    return false;
  };
  let lastShort: FairExclusion | null = null;

  /**
   * 'full' when the batch is; 'done' when this pass can take nothing more:
   * the range ran out under its exclusions, or a read that ignored them came
   * back with nothing this pass may take (an honest read that is not short
   * always fills the room), and the next, wider pass is the one to ask.
   */
  const pass = async (level: 'family' | 'recipient' | 'surplus'): Promise<'full' | 'done'> => {
    for (;;) {
      const room = size - taken.size;
      if (room <= 0) return 'full';
      const excluded: FairExclusion = level === 'surplus' ? NOTHING : {
        families: level === 'family' ? [...fullFamilies] : [],
        recipients: [...fullRecipients],
        familyWide: [...fullFamilyWide],
        marketplace: (level === 'family' && marketplaceFull) || marketplaceOutOfReach,
        listings: [...fullListings],
        landing: [...fullLanding],
        unlisted: unlistedFull,
      };
      if (lastShort && within(excluded, lastShort) && within(lastShort, excluded)) return 'done';
      let again = 0;
      for (const row of taken.values()) if (!isExcluded(excluded, row)) again += 1;
      const reach = level !== 'surplus' && !excluded.marketplace && held.size > 0;
      const want = reach ? Math.max(room + again, FAIR_READ_MAX_ROWS) : room + again;
      const rows = await read(want, excluded);
      let reached = false;
      let holding = 0;
      let added = 0;
      for (const row of rows) {
        // A read that ignored the exclusion must not count a row twice.
        if (taken.has(row.id) || isExcluded(excluded, row)) continue;
        if (added >= room) break;
        const market = isMarketplaceNotice(row);
        const family = familyOf(row);
        const recipient = recipientOf(row);
        const familyFull = level === 'family' && (byFamily.get(family) ?? 0) >= perFamily;
        const recipientFull = level !== 'surplus' && (byRecipient.get(recipient) ?? 0) >= perRecipient;
        // A drop whose listing (above) or seller has its share waits, as does
        // a drop not found once the drops not found hold a family's share; it
        // is left out by the name leaveOutSeller gives it, or, with no name
        // left, held back here and read past (`held`).
        const notFound = market && !sellerOf(row);
        const sellerFull = market && level !== 'surplus' && !familyFull && !recipientFull
          && ((bySeller.get(sellerShareOf(row)) ?? 0) >= perRecipient || (notFound && notFoundTaken >= perFamily));
        if (familyFull) {
          if (market) marketplaceFull = true;
          else fullFamilies.add(row.family_id);
        }
        if (recipientFull) {
          if (row.user_id) fullRecipients.add(row.user_id);
          else if (!market) fullFamilyWide.add(row.family_id);
          else if (row.related_id) fullListings.add(row.related_id);
          else unlistedFull = true;
        }
        if (familyFull || recipientFull) { reached = true; continue; }
        if (sellerFull) {
          if (leaveOutSeller(row)) reached = true;
          else { held.add(row.id); holding += 1; }
          continue;
        }
        taken.set(row.id, row);
        added += 1;
        byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
        byRecipient.set(recipient, (byRecipient.get(recipient) ?? 0) + 1);
        if (market) bySeller.set(sellerShareOf(row), (bySeller.get(sellerShareOf(row)) ?? 0) + 1);
        if (notFound) notFoundTaken += 1;
      }
      if (taken.size >= size) return 'full';
      if (reached) continue;
      if (rows.length < want) { lastShort = excluded; return 'done'; }
      // Not short, and filled by rows this pass took or holds back: read past
      // the held ones, then, once a read that far is still filled by them,
      // leave the marketplace out.
      if (holding && want < FAIR_READ_MAX_ROWS) continue;
      if (holding && !marketplaceOutOfReach) { marketplaceOutOfReach = true; continue; }
      return 'done';
    }
  };

  for (const level of ['family', 'recipient', 'surplus'] as const) {
    if (await pass(level) === 'full') break;
  }
  return [...taken.values()];
}

/**
 * One read over a cursor's two ranges, for readFairBatch: the rows ahead of
 * the cursor and the rows behind it (push's retries: failed deliveries inside
 * the retry window, rows skipped for configuration or cut by the run's time
 * budget, and any surplus a fair batch left behind).
 *
 * Behind the cursor keeps `behindShare` of each read for itself, so retries
 * progress whatever lies ahead: the wrap used to run only when the forward
 * page came back short, and one member's rows kept it full. Ahead takes the
 * rest, and any part of the reserve the retries do not need. Rows behind come
 * first in what the read returns, so the reserve is taken before the rows
 * ahead fill the room. A read that came back short is remembered: a later read
 * leaving out at least as much is answered from it instead of asking again.
 *
 * `behind` need not start at the oldest row: push's reads behind go on from
 * the retries' own place in its cursor, then go round to the oldest, so under
 * a flood ahead (no wrap) the reserve is not spent on the same oldest rows
 * every run. behindExhausted says when the batch took every row there, and
 * the retries start again from the oldest.
 */
export function aheadAndBehind<T extends FairRow>(ahead: FairRead<T>, behind: FairRead<T>, behindShare: number) {
  if (!(behindShare >= 0 && behindShare < 1)) throw new Error('The retries\' share of a read must be a fraction below one.');
  const remembered = (range: FairRead<T>) => {
    const seen = new Set<string>();
    const short: { excluded: FairExclusion; rows: T[] }[] = [];
    const readRange: FairRead<T> = async (size, excluded) => {
      if (size < 1) return [];
      const known = short.find((answer) => within(answer.excluded, excluded));
      if (known) return known.rows.filter((row) => !isExcluded(excluded, row)).slice(0, size);
      const rows = await range(size, excluded);
      for (const row of rows) seen.add(row.id);
      if (rows.length < size) short.push({ excluded, rows });
      return rows;
    };
    return { read: readRange, seen, short };
  };
  const forward = remembered(ahead);
  const wrap = remembered(behind);
  /** Whether a read of `range` leaving nothing out came back short, and the batch took every row it returned. */
  const exhausted = (range: ReturnType<typeof remembered>, batch: readonly FairRow[]) => {
    const ids = new Set(batch.map((row) => row.id));
    return range.short.some((answer) => isNothing(answer.excluded) && answer.rows.every((row) => ids.has(row.id)));
  };
  const read: FairRead<T> = async (size, excluded) => {
    const reserve = Math.floor(size * behindShare);
    let first = await forward.read(size - reserve, excluded);
    const second = await wrap.read(size - first.length, excluded);
    // The retries left part of their reserve: give it to the rows ahead.
    if (reserve > 0 && first.length === size - reserve && second.length < size - first.length) {
      first = await forward.read(size - second.length, excluded);
    }
    return [...second, ...first];
  };
  return {
    read,
    /** Whether this row of the batch was read from behind the cursor. */
    isBehind: (row: FairRow) => wrap.seen.has(row.id) && !forward.seen.has(row.id),
    /**
     * Whether the batch holds every row ahead of the cursor: a read of that
     * range leaving nothing out came back short, and the batch took every row
     * it returned. Only then has the traversal reached the end and wraps.
     */
    aheadExhausted: (batch: readonly FairRow[]) => exhausted(forward, batch),
    /** The same of the rows behind: the retries have been through them all and start again from the oldest. */
    behindExhausted: (batch: readonly FairRow[]) => exhausted(wrap, batch),
  };
}
