import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * The proposed economy SQL (proposed-economy.sql, not in supabase/migrations)
 * changes two things the app reads, and production may run either schema:
 *
 *  - section 2 adds marketplace_orders.buyer_family_id. An order the family
 *    WON (auction, Buy-It-Now, accepted negotiation) carries the SELLER's
 *    family_id, so the winner reads it only as family_id OR buyer_family_id.
 *  - section 8c drops the whole-row circle read on marketplace_listings and
 *    adds the view marketplace_circle_listings, so another family's listing is
 *    read from the view.
 *
 * Each case below runs on the schema AFTER the SQL (the column and view exist,
 * and the table no longer answers for other families) and BEFORE it (the
 * column and view are missing, and the table answers as the old policy did).
 * Missing objects answer exactly what PostgREST does: 42703 for the column,
 * PGRST205 for the view.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', memberId: 'm-self' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'fam-buyer', role: harness.role, member: { id: harness.memberId, family_id: 'fam-buyer' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { placeBidAction, buyNowAction } = await import('@/app/(app)/marketplace/auctions/actions');
const { proposeHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');
const { readTrustScoreInputsAction, setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');
const { readLiveAuctions, readSharedListings, readAuctionState, readCircleTitles } = await import('@/lib/marketplace/circle-reads');
const { circleColumns, resetMarketplaceSchemaWarnings } = await import('@/lib/marketplace/schema-compat');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const VIEW = 'marketplace_circle_listings';
const MISSING_COLUMN = { code: '42703', message: 'column marketplace_orders.buyer_family_id does not exist', details: null, hint: null };
const MISSING_VIEW = {
  code: 'PGRST205',
  message: `Could not find the table 'public.${VIEW}' in the schema cache`,
  details: null,
  hint: "Perhaps you meant the table 'public.marketplace_listings'",
};
const reply = (error: unknown) => ({ data: null, error, count: null, status: 400, statusText: 'Bad Request' });

/** A builder for a relation that does not exist: every call chains, every read answers `error`. */
function missingRelation(error: unknown): object {
  const builder: object = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(reply(error)).then(ok, bad);
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(reply(error));
      return () => builder;
    },
  });
  return builder;
}

/** The real builder, except that a filter naming `column` makes the read answer `error`. */
function missingColumn(real: object, column: string, error: unknown): object {
  let failing = false;
  const builder: object = new Proxy(real, {
    get(target, prop) {
      if (failing && prop === 'then') return (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(reply(error)).then(ok, bad);
      if (failing && (prop === 'maybeSingle' || prop === 'single')) return () => Promise.resolve(reply(error));
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes(column) && ['or', 'eq', 'select'].includes(String(prop))) failing = true;
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out === target ? builder : out;
      };
    },
  });
  return builder;
}

type Schema = 'after' | 'before';

/** An in-memory database on one side of the SQL, with every relation touched logged in order. */
function database(schema: Schema, rpc: Record<string, (args: Record<string, unknown>) => unknown> = {}): InMemorySupabase {
  const db = createInMemorySupabase({ rpc });
  const realFrom = db.from.bind(db);
  (db as unknown as { from: (table: string) => object }).from = (table: string) => {
    if (schema === 'before' && table === VIEW) {
      db.log.push({ table });
      return missingRelation(MISSING_VIEW);
    }
    const builder = realFrom(table);
    if (schema === 'before' && table === 'marketplace_orders') return missingColumn(builder, 'buyer_family_id', MISSING_COLUMN);
    return builder;
  };
  harness.db = db;
  return db;
}

/** Seed one listing where each schema can read it: another family's goes to the view after, to the table before. */
function seedListing(db: InMemorySupabase, schema: Schema, row: Row) {
  const crossFamily = row.family_id !== 'fam-buyer';
  db.seed(schema === 'after' && crossFamily ? VIEW : 'marketplace_listings', [row]);
}

const auction = (over: Row): Row => ({
  sale_format: 'auction', status: 'available', title: 'Bike', photo_url: null, category: 'sports',
  starting_bid_cents: 1_000, current_bid_cents: 0, bid_count: 0, has_reserve: false, reserve_met: false,
  buy_now_cents: 15_000, auction_starts_at: null, highest_bidder_family_id: null, ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
let rpcCalls: string[];
const record = (name: string, answer: unknown) => () => { rpcCalls.push(name); return answer; };

beforeEach(() => {
  harness.role = 'parent';
  harness.memberId = 'm-self';
  rpcCalls = [];
  resetMarketplaceSchemaWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const warned = (object: string) => warn.mock.calls.some((call: unknown[]) => String(call[0]).includes(object));

describe('orders are read by the family on either side (buyer_family_id)', () => {
  it('after the SQL: the household that won an order reads it, arranges the pickup and advances it', async () => {
    const db = database('after');
    db.seed('marketplace_orders', [{
      id: 'order-won', family_id: 'fam-seller', buyer_family_id: 'fam-buyer', listing_id: 'listing-1',
      buyer_member: 'm-self', seller_member: 'm-seller', kind: 'sell', status: 'confirmed',
    }]);
    expect(await proposeHandoffAction({ orderId: 'order-won', locationLabel: 'Library' })).toEqual({ ok: true });
    expect(db.table('marketplace_handoffs')).toMatchObject([{ order_id: 'order-won', family_id: 'fam-seller', proposer_role: 'buyer' }]);
    expect(await setOrderStatusAction('order-won', 'active')).toEqual({ ok: true });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'active' });
    expect(warned('buyer_family_id')).toBe(false);
  });

  it('after the SQL: a third family still reads nothing', async () => {
    const db = database('after');
    db.seed('marketplace_orders', [{
      id: 'order-other', family_id: 'fam-seller', buyer_family_id: 'fam-third', listing_id: 'listing-1',
      buyer_member: 'm-third', seller_member: 'm-seller', kind: 'sell', status: 'confirmed',
    }]);
    expect(await proposeHandoffAction({ orderId: 'order-other', locationLabel: 'Library' })).toEqual({ ok: false, error: t('actions.orderNotFound') });
  });

  it('before the SQL: the missing column falls back to the seller-family read, and in-family orders still work', async () => {
    const db = database('before');
    db.seed('marketplace_orders', [{
      id: 'order-home', family_id: 'fam-buyer', listing_id: 'listing-1',
      buyer_member: 'm-self', seller_member: 'm-sibling', kind: 'sell', status: 'confirmed',
    }]);
    db.seed('family_members', [{ id: 'm-sibling', family_id: 'fam-buyer', role: 'teen', is_active: true }]);
    expect(await proposeHandoffAction({ orderId: 'order-home', locationLabel: 'Kitchen' })).toEqual({ ok: true });
    expect(await setOrderStatusAction('order-home', 'active')).toEqual({ ok: true });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'active' });
    // The new read was tried, recognised as the missing column, and retried.
    expect(warned('marketplace_orders.buyer_family_id')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('every order read scoped to the active family goes through readFamilyOrders', () => {
    for (const file of [
      'app/(app)/marketplace/handoff/actions.ts',
      'app/(app)/marketplace/orders/page.tsx',
      'app/(app)/marketplace/actions.ts',
      'app/(app)/marketplace/page.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readFamilyOrders(');
      // No order read in these files narrows itself to family_id alone.
      expect(source, file).not.toMatch(/from\('marketplace_orders'\)(?:(?!\.from\()[^;])*?\.select\((?:(?!\.from\()[^;])*?\.eq\('family_id'/);
    }
  });
});

/** Every file under `roots` that is a client component: the browser runs it. */
function clientComponents(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && /^'use client'/.test(readFileSync(path, 'utf8'))) out.push(path);
    }
  };
  roots.forEach(walk);
  return out;
}

describe('the rail\'s Trust Score card is read on the server', () => {
  // The order read asks for buyer_family_id and, on a database without the SQL,
  // is answered 400 before readFamilyOrders falls back. In Node that is a
  // response to a fetch and nothing more. In the browser Chromium also prints
  // "Failed to load resource: the server responded with a status of 400" to
  // the console, and the rail is on every marketplace page: one browser-side
  // read in the Trust Score card turned every /marketplace route of the
  // signed-in sweep red (tests/e2e/every-page-signed-in.spec.ts asserts no
  // console errors). So the inputs are read by a server action and only
  // scored in the browser.
  it('no client component makes the buyer_family_id probe from the browser', () => {
    const clients = clientComponents(['app', 'components']);
    expect(clients.length).toBeGreaterThan(100);
    const probing = clients.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('@/lib/marketplace/schema-compat') || source.includes('buyer_family_id');
    });
    expect(probing, 'read marketplace_orders through a server action instead').toEqual([]);
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: the member\'s received ratings, completed exchanges on either side, and listings', async (schema) => {
    const db = database(schema);
    db.seed('marketplace_orders', [
      // Won from another household: the seller's family_id, the buyer's buyer_family_id.
      { id: 'won', family_id: 'fam-seller', buyer_family_id: 'fam-buyer', buyer_member: 'm-self', seller_member: 'm-seller', status: 'completed' },
      { id: 'sold', family_id: 'fam-buyer', buyer_member: 'm-sibling', seller_member: 'm-self', status: 'completed' },
      { id: 'open', family_id: 'fam-buyer', buyer_member: 'm-self', seller_member: 'm-sibling', status: 'confirmed' },
      { id: 'siblings', family_id: 'fam-buyer', buyer_member: 'm-sibling', seller_member: 'm-other', status: 'completed' },
    ]);
    db.seed('marketplace_reviews', [
      { family_id: 'fam-buyer', reviewee_member: 'm-self', rating: 5 },
      { family_id: 'fam-buyer', reviewee_member: 'm-sibling', rating: 2 },
    ]);
    db.seed('marketplace_listings', [
      { id: 'mine', family_id: 'fam-buyer', member_id: 'm-self' },
      { id: 'theirs', family_id: 'fam-buyer', member_id: 'm-sibling' },
    ]);
    expect(await readTrustScoreInputsAction()).toEqual({
      ok: true, memberId: 'm-self', ratingsReceived: [5],
      // Before the SQL the won order is the seller family's alone, as it always was.
      ordersCompleted: schema === 'after' ? 2 : 1,
      listingsPosted: 1,
    });
    expect(warned('marketplace_orders.buyer_family_id')).toBe(schema === 'before');
    expect(db.log.map((l) => l.table)).toEqual(schema === 'after'
      ? ['marketplace_reviews', 'marketplace_orders', 'marketplace_listings']
      : ['marketplace_reviews', 'marketplace_orders', 'marketplace_listings', 'marketplace_orders']);
  });

  it('a read that fails is reported, not scored as a baseline', async () => {
    const db = database('after');
    const realFrom = db.from.bind(db);
    (db as unknown as { from: (table: string) => object }).from = (table: string) => table === 'marketplace_reviews'
      ? missingRelation({ code: '42P01', message: 'relation "public.marketplace_reviews" does not exist', details: null, hint: null })
      : realFrom(table);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await readTrustScoreInputsAction()).toEqual({ ok: false, error: expect.any(String) });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe('another family\'s listing is read through marketplace_circle_listings', () => {
  const rows = (schema: Schema, db: InMemorySupabase) => {
    seedListing(db, schema, auction({ id: 'own', family_id: 'fam-buyer', auction_ends_at: '2099-01-03T00:00:00Z' }));
    seedListing(db, schema, auction({ id: 'theirs', family_id: 'fam-seller', auction_ends_at: '2099-01-02T00:00:00Z' }));
  };

  it.each<Schema>(['after', 'before'])('%s the SQL: the auctions board shows both families\' auctions, soonest first', async (schema) => {
    const db = database(schema);
    rows(schema, db);
    const { data, error } = await readLiveAuctions(db as never, 'fam-buyer', '2099-01-01T00:00:00Z');
    expect(error).toBeNull();
    expect(data?.map((r) => r.id)).toEqual(['theirs', 'own']);
    expect(db.log[0].table).toBe(VIEW);
    if (schema === 'after') {
      expect(db.log.map((l) => l.table)).toEqual([VIEW, 'marketplace_listings']);
      expect(warned(VIEW)).toBe(false);
    } else {
      // Tried the view, then today's single table read.
      expect(db.log.map((l) => l.table)).toEqual([VIEW, 'marketplace_listings']);
      expect(warned(`view public.${VIEW}`)).toBe(true);
    }
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: the community feed reads every shared listing', async (schema) => {
    const db = database(schema);
    seedListing(db, schema, { id: 'own', family_id: 'fam-buyer', title: 'Tent', kind: 'sell', category: 'outdoor', condition: null, price_cents: 100, rent_period: null, status: 'claimed' });
    seedListing(db, schema, { id: 'theirs', family_id: 'fam-seller', title: 'Bike', kind: 'sell', category: 'sports', condition: null, price_cents: 200, rent_period: null, status: 'available' });
    const shares = [
      { listing_id: 'own', circle_id: 'c1', family_id: 'fam-buyer', created_at: '2099-01-01' },
      { listing_id: 'theirs', circle_id: 'c1', family_id: 'fam-seller', created_at: '2099-01-01' },
    ];
    const { data, error } = await readSharedListings(db as never, 'fam-buyer', shares);
    expect(error).toBeNull();
    expect(data?.map((r) => r.id).sort()).toEqual(['own', 'theirs']);
    expect(db.log[0].table).toBe(VIEW);
    expect(warned(VIEW)).toBe(schema === 'before');
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: the auction panel reads another family\'s live state', async (schema) => {
    const db = database(schema);
    seedListing(db, schema, auction({ id: 'theirs', family_id: 'fam-seller', bid_count: 2, current_bid_cents: 4_000, auction_ends_at: '2099-01-02T00:00:00Z' }));
    const { data, error } = await readAuctionState(db as never, 'theirs', { ownFamily: false });
    expect(error).toBeNull();
    expect(data).toMatchObject({ bid_count: 2, current_bid_cents: 4_000 });
    if (schema === 'after') expect(db.log.map((l) => l.table)).toEqual(['marketplace_listings', VIEW]);
    else expect(db.log.map((l) => l.table)).toEqual(['marketplace_listings']);
  });

  it('before the SQL: a listing neither the table nor the (missing) view has is null, not an error', async () => {
    const db = database('before');
    const { data, error } = await readAuctionState(db as never, 'gone', { ownFamily: false });
    expect({ data, error }).toEqual({ data: null, error: null });
    expect(db.log.map((l) => l.table)).toEqual(['marketplace_listings', VIEW]);
    expect(warned(VIEW)).toBe(true);
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: an order\'s title is found for a listing the family won', async (schema) => {
    const db = database(schema);
    db.seed(VIEW, schema === 'after' ? [{ id: 'won', family_id: 'fam-seller', title: 'Bike' }] : []);
    const { data, error } = await readCircleTitles(db as never, ['won']);
    expect(error).toBeNull();
    expect(data).toEqual(schema === 'after' ? [{ id: 'won', title: 'Bike' }] : []);
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: placeBid refuses the household that already leads another family\'s auction', async (schema) => {
    const db = database(schema, { marketplace_place_bid: record('marketplace_place_bid', { ok: true, leading: true, current_cents: 1 }) });
    seedListing(db, schema, auction({ id: 'theirs', family_id: 'fam-seller', bid_count: 1, current_bid_cents: 5_000, highest_bidder_family_id: 'fam-buyer' }));
    expect(await placeBidAction({ listingId: 'theirs', maxCents: 9_000 })).toEqual({ ok: false, error: t('actions.youAlreadyLeadThisAuction') });
    expect(rpcCalls).toEqual([]);
  });

  it('before the SQL: placeBid tries the view for a listing the table did not return, then lets the RPC decide', async () => {
    const db = database('before', { marketplace_place_bid: record('marketplace_place_bid', { ok: false, reason: 'not_found' }) });
    expect(await placeBidAction({ listingId: 'unseen', maxCents: 9_000 })).toEqual({ ok: false, error: t('actions.thatListingNoLongerExists') });
    expect(db.log.map((l) => l.table)).toEqual(['marketplace_listings', VIEW]);
    expect(rpcCalls).toEqual(['marketplace_place_bid']);
    expect(warned(VIEW)).toBe(true);
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: buyNow sees the bid on another family\'s auction and refuses', async (schema) => {
    const db = database(schema, { marketplace_buy_now: record('marketplace_buy_now', { ok: true, order_id: 'o' }) });
    seedListing(db, schema, auction({ id: 'theirs', family_id: 'fam-seller', bid_count: 1, current_bid_cents: 5_000 }));
    expect(await buyNowAction('theirs')).toEqual({ ok: false, error: t('actions.buyItNowIsnT') });
    expect(rpcCalls).toEqual([]);
  });

  it.each<Schema>(['after', 'before'])('%s the SQL: buyNow on another family\'s auction with no bid reaches the RPC', async (schema) => {
    const db = database(schema, { marketplace_buy_now: record('marketplace_buy_now', { ok: true, order_id: 'order-9' }) });
    seedListing(db, schema, auction({ id: 'theirs', family_id: 'fam-seller' }));
    expect(await buyNowAction('theirs')).toEqual({ ok: true, data: { orderId: 'order-9' } });
    expect(rpcCalls).toEqual(['marketplace_buy_now']);
    expect(db.log.map((l) => l.table)).toEqual(schema === 'after' ? ['marketplace_listings', VIEW] : ['marketplace_listings']);
  });

  it('before the SQL: buyNow tries the view for a listing the table did not return, and says it is gone', async () => {
    const db = database('before', { marketplace_buy_now: record('marketplace_buy_now', { ok: true, order_id: 'o' }) });
    expect(await buyNowAction('unseen')).toEqual({ ok: false, error: t('actions.listingNotFound') });
    expect(db.log.map((l) => l.table)).toEqual(['marketplace_listings', VIEW]);
    expect(rpcCalls).toEqual([]);
    expect(warned(VIEW)).toBe(true);
  });

  it('asks the view only for columns it exposes', () => {
    expect(() => circleColumns('id, title, location')).toThrow(/location/);
    expect(() => circleColumns('id, member_id')).toThrow(/member_id/);
    expect(() => circleColumns('id, reserve_cents')).toThrow(/reserve_cents/);
    expect(circleColumns('id, title, highest_bidder_family_id, has_reserve')).toBe('id, title, highest_bidder_family_id, has_reserve');
  });

  it('the pages and the panel use the readers, not a direct cross-family table read', () => {
    expect(readFileSync('app/(app)/marketplace/auctions/page.tsx', 'utf8')).toContain('readLiveAuctions(');
    expect(readFileSync('app/(app)/marketplace/community/page.tsx', 'utf8')).toContain('readSharedListings(');
    expect(readFileSync('components/marketplace/auction-panel.tsx', 'utf8')).toContain('readAuctionState(');
    const actions = readFileSync('app/(app)/marketplace/auctions/actions.ts', 'utf8');
    expect(actions.match(/readBidTarget\(/g)).toHaveLength(2);
    expect(actions).not.toContain(".from('marketplace_listings')");
  });
});

describe('the refusals the SQL adds are said in the catalogue', () => {
  it('maps manager_only and already_leading from marketplace_place_bid', async () => {
    database('after', { marketplace_place_bid: () => ({ ok: false, reason: 'manager_only' }) });
    expect(await placeBidAction({ listingId: 'x', maxCents: 1_000 })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan16') });
    database('after', { marketplace_place_bid: () => ({ ok: false, reason: 'already_leading', leading: true, current_cents: 5_000 }) });
    expect(await placeBidAction({ listingId: 'x', maxCents: 1_000 })).toEqual({ ok: false, error: t('actions.yourMaxAlreadyCoversThat') });
    expect(t('actions.yourMaxAlreadyCoversThat')).not.toBe('actions.yourMaxAlreadyCoversThat');
  });

  it('maps manager_only and the bids_placed detail from marketplace_buy_now', async () => {
    const db = database('after', { marketplace_buy_now: () => ({ ok: false, reason: 'manager_only' }) });
    db.seed('marketplace_listings', [auction({ id: 'own', family_id: 'fam-buyer' })]);
    expect(await buyNowAction('own')).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan16') });
    const raced = database('after', { marketplace_buy_now: () => ({ ok: false, reason: 'not_available', detail: 'bids_placed' }) });
    raced.seed('marketplace_listings', [auction({ id: 'own', family_id: 'fam-buyer' })]);
    expect(await buyNowAction('own')).toEqual({ ok: false, error: t('actions.buyItNowIsnT') });
  });
});
