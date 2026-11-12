// The auction close cron, driven over HTTP with its real secret check, over
// two open households and the rows it must leave alone.
//
// The neighbouring tests (a-closed-familys-auction-is-not-settled,
// an-auction-is-not-settled-to-a-closed-winner,
// an-auction-notice-that-failed-is-sent-later) mock the secret check, the
// notice scope and notify() itself, so none of them shows what the run WRITES:
// which notification rows land, for which members of which household. Here the
// real hasCronAuthorization, systemScopeForFamily and notify() run against the
// in-memory database; only marketplace_close_auction (SQL, modelled on 0483)
// is supplied. notify() only writes rows — push and email are later crons —
// so there is no provider to stub on this route.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown, service: vi.fn(), touched: [] as string[], closed: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: harness.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { GET } = await import('@/app/api/cron/close-auctions/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

// Households. A and B sell; WA and WB win; C is a closed seller; WC a closed winner.
const A = id('a1'), B = id('b1'), WA = id('a2'), WB = id('b2'), C = id('c1'), WC = id('c2');
const user = (family: string, n: number) => id(`${family.slice(-2)}${n}0`);

const request = (authorization?: string) => new NextRequest('http://localhost/api/cron/close-auctions', {
  headers: authorization === undefined ? {} : { authorization },
});
const run = async (authorization = `Bearer ${SECRET}`) => {
  const res = await GET(request(authorization));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

/** 0483's settlement: sold when there are bids, a leader, and the leader's max meets the reserve; otherwise withdrawn. */
function closeAuction(args: Record<string, unknown>, mem: InMemorySupabase) {
  harness.closed.push(String(args.p_listing_id));
  const listing = mem.table('marketplace_listings').find((l) => l.id === args.p_listing_id) as Row;
  const bids = Number(listing.bid_count ?? 0);
  const sold = bids > 0 && listing.highest_bidder_member_id != null && Number(listing.highest_max_cents) >= Number(listing.reserve_cents ?? 0);
  if (!sold) {
    Object.assign(listing, { status: 'withdrawn', auction_closed_at: args.p_now });
    return { ok: true, reason: 'closed', sold: false, had_bids: bids > 0, title: listing.title, seller_family_id: listing.family_id, order_id: null };
  }
  Object.assign(listing, { status: 'claimed', claimed_by: listing.highest_bidder_member_id, auction_closed_at: args.p_now });
  const order = { id: id(`dd${String(listing.id).slice(-3)}`), listing_id: listing.id, amount_cents: listing.current_bid_cents, notes: 'Won at auction' };
  mem.seed('marketplace_orders', [order]);
  return {
    ok: true, reason: 'closed', sold: true, had_bids: true, title: listing.title,
    seller_family_id: listing.family_id, winner_family_id: listing.highest_bidder_family_id,
    current_bid_cents: listing.current_bid_cents, order_id: order.id,
  };
}

function auction(listingId: string, seller: string, winner: string | null, over: Row = {}): Row {
  const row: Row = {
    id: listingId, title: `Bike ${listingId.slice(-3)}`, family_id: seller, sale_format: 'auction', status: 'available',
    auction_ends_at: ago(1), auction_closed_at: null, bid_count: winner ? 2 : 0, current_bid_cents: 5_000,
    highest_max_cents: 6_000, reserve_cents: null,
    highest_bidder_member_id: winner ? id(`${winner.slice(-2)}e1`) : null, highest_bidder_family_id: winner, claimed_by: null, ...over,
  };
  return { ...row, has_reserve: row.reserve_cents !== null, reserve_met: row.reserve_cents === null || Number(row.current_bid_cents) >= Number(row.reserve_cents) };
}

const L = {
  aToWa: id('1a1'), bToWb: id('1b1'), bUnsold: id('1b2'), closedSeller: id('1c1'), closedWinner: id('1c2'),
  notYetEnded: id('1a3'), settledEarlier: id('1a4'),
};
const listing = (listingId: string) => db.table('marketplace_listings').find((l) => l.id === listingId)!;
const order = (listingId: string) => db.table('marketplace_orders').find((o) => o.listing_id === listingId);
const notices = () => db.table('notifications');
const noticesFor = (familyId: string) => notices().filter((n) => n.family_id === familyId);

let db: InMemorySupabase;

function seed() {
  // 0002: `is_read boolean not null default false`.
  db = createInMemorySupabase({ rpc: { marketplace_close_auction: closeAuction }, defaults: { notifications: { is_read: false } } });
  db.seed('families', [
    { id: A, timezone: 'Europe/Berlin', closed_at: null }, { id: B, timezone: 'America/Los_Angeles', closed_at: null },
    { id: WA, timezone: 'UTC', closed_at: null }, { id: WB, timezone: 'Asia/Tokyo', closed_at: null },
    { id: C, timezone: 'UTC', closed_at: ago(48) }, { id: WC, timezone: 'UTC', closed_at: ago(48) },
  ]);
  const members: Row[] = [];
  for (const family of [A, B, WA, WB, C, WC]) {
    members.push(
      { id: id(`${family.slice(-2)}e1`), family_id: family, user_id: user(family, 1), role: 'parent', is_active: true },
      { id: id(`${family.slice(-2)}e2`), family_id: family, user_id: user(family, 2), role: 'child', is_active: true },
    );
  }
  // Rows the fan-out must skip: a removed member, and a managed profile with no login.
  members.push({ id: id('a1e3'), family_id: A, user_id: id('a1f0'), role: 'adult', is_active: false });
  members.push({ id: id('b1e3'), family_id: B, user_id: null, role: 'child', is_active: true });
  db.seed('family_members', members);
  db.seed('family_ai_settings', []);
  db.seed('notifications', []);
  db.seed('marketplace_orders', [{ id: id('dd1a4'), listing_id: L.settledEarlier, amount_cents: 7_000, notes: 'Won at auction' }]);
  db.seed('marketplace_listings', [
    auction(L.aToWa, A, WA),
    auction(L.bToWb, B, WB, { current_bid_cents: 9_900, highest_max_cents: 9_900 }),
    // Bids, but the reserve was missed: closes unsold and the seller is told.
    auction(L.bUnsold, B, WA, { current_bid_cents: 3_000, highest_max_cents: 3_000, reserve_cents: 5_000 }),
    auction(L.closedSeller, C, WB),
    auction(L.closedWinner, A, WC),
    auction(L.notYetEnded, A, WB, { auction_ends_at: new Date(NOW.getTime() + HOUR).toISOString() }),
    // Settled by an earlier run whose notices were delivered.
    auction(L.settledEarlier, A, WB, { status: 'claimed', claimed_by: id('b2e1'), auction_closed_at: ago(5) }),
  ]);
  db.seed('notifications', [WB, A].flatMap((family) => [1, 2].map((n) => ({
    id: id(`9${family.slice(-2)}${n}`), family_id: family, user_id: user(family, n), type: 'system', title: 'earlier',
    related_type: 'marketplace_orders', related_id: id('dd1a4'), is_read: true,
  }))));
}

/** Every property read on the client, so "touched nothing" is checked rather than assumed. */
function recording(client: object) {
  return new Proxy(client, { get(target, key, receiver) { harness.touched.push(String(key)); return Reflect.get(target, key, receiver); } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.touched = [];
  harness.closed = [];
  seed();
  harness.db = recording(db);
  harness.service.mockReset().mockImplementation(() => harness.db);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('GET /api/cron/close-auctions', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer not-the-secret'],
  ])('API-19C785624D88 JOB-462EDF9EBA28: refuses %s with 401 before any read or write', async (_label, authorization) => {
    const res = await GET(request(authorization));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'closeAuctions.unauthorized' });
    expect(harness.service).not.toHaveBeenCalled();
    expect(harness.touched).toEqual([]);
    expect(harness.closed).toEqual([]);
    expect(notices()).toHaveLength(4);
  });

  it('API-19C785624D88 JOB-462EDF9EBA28: the right secret settles the two open households\' due auctions and skips the rest', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    // `rechecked` is left out: it counts re-offers that were no-ops (see the report).
    expect(body).toMatchObject({ ok: true, closed: 3, sold: 2, unsold: 1, failed: 0, skipped: 0, heldForClosedBidder: 1 });
    expect(harness.service).toHaveBeenCalledOnce();

    // Settled: the two sales and the unsold one, nothing else.
    expect([...harness.closed].sort()).toEqual([L.aToWa, L.bToWb, L.bUnsold].sort());
    expect(listing(L.aToWa)).toMatchObject({ status: 'claimed', claimed_by: id('a2e1'), auction_closed_at: NOW.toISOString() });
    expect(listing(L.bToWb)).toMatchObject({ status: 'claimed', claimed_by: id('b2e1') });
    expect(listing(L.bUnsold)).toMatchObject({ status: 'withdrawn', claimed_by: null });
    // Skipped: a closed seller, a closed winner, an auction still running.
    for (const skipped of [L.closedSeller, L.closedWinner, L.notYetEnded]) {
      expect(listing(skipped)).toMatchObject({ status: 'available', claimed_by: null, auction_closed_at: null });
      expect(order(skipped)).toBeUndefined();
    }

    // One row per active member with a login; the removed adult and the managed child get none.
    const fresh = notices().filter((n) => n.title !== 'earlier');
    expect(fresh.map((n) => `${n.family_id}|${n.user_id}|${n.title}`).sort()).toEqual([
      `${A}|${user(A, 1)}|Auction sold: "Bike 1a1"`, `${A}|${user(A, 2)}|Auction sold: "Bike 1a1"`,
      `${B}|${user(B, 1)}|Auction ended: "Bike 1b2"`, `${B}|${user(B, 1)}|Auction sold: "Bike 1b1"`,
      `${B}|${user(B, 2)}|Auction ended: "Bike 1b2"`, `${B}|${user(B, 2)}|Auction sold: "Bike 1b1"`,
      `${WA}|${user(WA, 1)}|You won "Bike 1a1"`, `${WA}|${user(WA, 2)}|You won "Bike 1a1"`,
      `${WB}|${user(WB, 1)}|You won "Bike 1b1"`, `${WB}|${user(WB, 2)}|You won "Bike 1b1"`,
    ].sort());
    expect(fresh.map((n) => n.user_id)).not.toContain(id('a1f0'));
    expect(fresh.map((n) => n.user_id)).not.toContain(null);
    for (const family of [C, WC]) expect(noticesFor(family)).toEqual([]);
    expect(noticesFor(WA).map((n) => n.body)).toEqual(['Final price $50.00. Open your orders to arrange pickup.', 'Final price $50.00. Open your orders to arrange pickup.']);
  });

  it('API-19C785624D88 JOB-462EDF9EBA28: nothing derived from one household\'s sale reaches the other', async () => {
    await run();
    const orderA = order(L.aToWa)!.id;
    const orderB = order(L.bToWb)!.id;
    const usersOf = (family: string) => new Set(db.table('family_members').filter((m) => m.family_id === family).map((m) => m.user_id));
    for (const n of notices().filter((row) => row.title !== 'earlier')) expect(usersOf(String(n.family_id)).has(n.user_id), `${String(n.user_id)} belongs to ${String(n.family_id)}`).toBe(true);
    // Sale A (A → WA) is told only to A and WA; sale B only to B and WB.
    expect(new Set(notices().filter((n) => n.related_id === orderA).map((n) => n.family_id))).toEqual(new Set([A, WA]));
    expect(new Set(notices().filter((n) => n.related_id === orderB).map((n) => n.family_id))).toEqual(new Set([B, WB]));
    expect(noticesFor(A).some((n) => String(n.title).includes('1b1') || String(n.body).includes('$99.00'))).toBe(false);
    expect(noticesFor(WA).some((n) => String(n.title).includes('1b1'))).toBe(false);
  });

  it('API-19C785624D88 JOB-462EDF9EBA28: a second run settles nothing and sends nothing new, even after everyone read the first notices', async () => {
    await run();
    // Read state is not the dedupe: a notice already read must not be sent again.
    for (const n of notices()) n.is_read = true;
    const rows = notices().length;
    const orders = db.table('marketplace_orders').length;
    harness.closed = [];
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, closed: 0, sold: 0, unsold: 0, failed: 0, skipped: 0, heldForClosedBidder: 1 });
    expect(harness.closed).toEqual([]);
    expect(notices()).toHaveLength(rows);
    expect(db.table('marketplace_orders')).toHaveLength(orders);
  });

  it('API-19C785624D88 JOB-462EDF9EBA28: a due read that fails answers 500 and settles nothing', async () => {
    harness.db = withFaults(db, (table, calls: FaultCall[]) => (table === 'marketplace_listings' && calls.some((c) => c.method === 'lt')
      ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const { status, body } = await run();
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, error: 'closeAuctions.couldNotLoadAuctions' });
    expect(harness.closed).toEqual([]);
    expect(notices()).toHaveLength(4);
  });

  it('API-19C785624D88 JOB-462EDF9EBA28: a notice write that fails for one household is a 502, the other is still told, and the next run re-offers it', async () => {
    // Every notice write for seller A's household is refused on this run.
    harness.db = withFaults(db, (table, calls: FaultCall[]) => {
      const insert = calls.find((c) => c.method === 'insert');
      const rows = insert ? (insert.args[0] as Row[]) : [];
      return table === 'notifications' && rows.some((r) => r.family_id === A) ? { message: 'insert refused' } : null;
    });
    const first = await run();
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ ok: false, closed: 3, sold: 2, unsold: 1, failed: 1 });
    expect(noticesFor(A).filter((n) => n.title !== 'earlier')).toEqual([]);
    // The settlement committed, and B's sale and the winner of A's sale were still told.
    expect(listing(L.aToWa).status).toBe('claimed');
    expect(noticesFor(WA)).toHaveLength(2);
    expect(noticesFor(B)).toHaveLength(4);
    expect(noticesFor(WB).filter((n) => n.title !== 'earlier')).toHaveLength(2);

    // The fault clears: the retry window re-offers A's notice once, and repeats nobody else's.
    harness.db = db;
    const before = notices().length;
    const second = await run();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, closed: 0, failed: 0 });
    expect(notices().length - before).toBe(2);
    expect(noticesFor(A).filter((n) => n.related_id === order(L.aToWa)!.id).map((n) => n.user_id).sort()).toEqual([user(A, 1), user(A, 2)].sort());
  });
});
