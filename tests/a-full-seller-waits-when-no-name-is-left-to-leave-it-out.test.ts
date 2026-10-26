// household-roles round 14 (OWNER-R14-EXHAUSTED-NAMES-LIFT-SELLER-SHARE): a
// full seller's price drops still wait once the names a read can leave them
// out by are spent.
//
// A seller is not a column of a notification, so a read leaves a full
// seller's drops out by name: its own family, its listings (twenty a batch of
// 200), then the families they landed in (twenty more), and no further, so
// that the read's request line stays bounded (lib/notifications/fair-batch.ts,
// and tests/the-most-a-push-read-leaves-out-fits-its-request-line.test.ts).
// Past those names the seller's further drops were taken against their own
// listing's share alone. The repository owner's reproduction on PR #1131: one
// seller's 1,000 drops across 500 listings, each saved by a different family,
// filled the whole batch, and another seller's price drop behind them was not
// in it. The marketplace-wide share kept an ordinary notification's place,
// which is all the existing case checked.
//
// Now a full seller's drop with no name left is held back all the same, and
// the read reaches past what it holds back: up to FAIR_READ_MAX_ROWS rows,
// PostgREST's db-max-rows. Once a read that far is still filled by them, the
// marketplace is left out of the shared passes, so every family's own rows
// behind them are still reached. Another seller's drop behind more held-back
// drops than a read can reach past waits for the surplus; the cases below pin
// that bound to the row. Driven through the real dispatchPendingPushes on the in-memory database
// with PostgREST's row cap and the web-push mock live, one call per two-hourly
// tick; the last cases read the batch read by read, at push's shares and the
// email digest's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { FairExclusion } from '@/lib/notifications/fair-batch';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { notificationId } from './helpers/push-dispatch-db';

const providers = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }) => {
      providers.pushed.push(subscription.endpoint.split('/').pop()!);
      return { statusCode: 201 };
    },
  },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

const { dispatchPendingPushes, PUSH_RETRY_SHARE, PUSH_ROWS_PER_FAMILY, PUSH_ROWS_PER_RECIPIENT } = await import('@/lib/server/push');
const { EMAIL_ROWS_PER_FAMILY, EMAIL_ROWS_PER_RECIPIENT } = await import('@/lib/server/notification-emails');
const { aheadAndBehind, readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
/** dispatchPendingPushes' batch, and the names a read keeps for a full seller's listings, and as many for their landing families. */
const PUSH_BATCH = 200;
const PUSH_NAMED = PUSH_BATCH / PUSH_ROWS_PER_RECIPIENT;
/** PostgREST's db-max-rows, the most rows one read may ask for and be answered in full (lib/supabase/read-all.ts). */
const DB_MAX_ROWS = 1000;
/**
 * The most listings of one seller, each saved by a different family with one
 * drop, that another seller's drop behind them is still reached past on the
 * first tick: the seller's share taken, its twenty listing and twenty landing
 * names left out, and the rest held back, all but those named fit in one read
 * with the drop. Written out, not derived from fair-batch.ts, so a read that
 * asks for more or fewer rows fails here.
 */
const AT_THE_BOUND = 1039;
/** Listing ids are uuids, as 0191 writes them into related_id. */
const listingId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const at = (ms: number) => new Date(ms).toISOString();
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;

const notice = (id: string, familyId: string, userId: string | null, createdAt: string, title: string, listing?: string): Row => ({
  id, family_id: familyId, user_id: userId, type: 'system', title, body: null,
  related_type: listing ? 'marketplace_listings' : null, related_id: listing ?? null,
  is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
});
const device = (id: string, userId: string): Row => ({
  id, user_id: userId, enabled: true, provider: 'webpush', platform: 'web', endpoint: `https://push.example.test/${id}`,
  p256dh: 'key', auth: 'auth', token: null, last_seen_at: '2026-10-01T00:00:00.000Z',
});
const listing = (id: string, familyId: string): Row => ({ id, family_id: familyId, title: 'Bike', price_cents: 5000, status: 'available' });
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;
const family = (id: string) => ({ id, timezone: 'UTC', closed_at: null });
const member = (familyId: string, userId: string, role = 'parent') =>
  ({ id: `m-${userId}`, family_id: familyId, user_id: userId, role, is_active: true });

/** One dispatch a tick until `id` is pushed; how many ticks that took (at most `max`). */
async function ticksUntilPushed(id: string, max: number): Promise<number> {
  let ticks = 0;
  for (let t = NOW.getTime(); !row(id).pushed_at && ticks < max; t += TICK_MS) {
    vi.setSystemTime(new Date(t));
    await dispatchPendingPushes(asDb(), { now: new Date(t) });
    ticks += 1;
  }
  return ticks;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.pushed = [];
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('user_preferences', []);
  db.seed('family_ai_settings', []);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('push: one seller\'s flood across more listings and families than the names hold', () => {
  const SELLER = 'fam-seller';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_WATCHER = 'fam-honest-watcher';
  const HONEST_LISTING = listingId(99_999);
  const HONEST_DROP = notificationId(900_001);
  const watcher = (i: number) => `fam-watcher-${i}`;

  /**
   * The seller's `listings` listings, each saved by a different family, with
   * `drops` drops between them in turn, an hour before now; then, a minute
   * before now, `last` (another seller's price drop by default).
   */
  function flood(listings: number, drops: number, extra: { families?: string[]; members?: Row[]; devices?: Row[]; last?: Row[] } = {}) {
    const watchers = Array.from({ length: listings }, (_, i) => watcher(i));
    db.seed('families', [SELLER, HONEST_SELLER, HONEST_WATCHER, ...watchers, ...(extra.families ?? [])].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller', 'child'), member(HONEST_SELLER, 'u-honest'), member(HONEST_WATCHER, 'u-honest-watcher'),
      ...(extra.members ?? [])]);
    db.seed('push_devices', [device('phone-honest-watcher', 'u-honest-watcher'), ...(extra.devices ?? [])]);
    db.seed('marketplace_listings', [...watchers.map((_, i) => listing(listingId(i + 1), SELLER)), listing(HONEST_LISTING, HONEST_SELLER)]);
    const rows = Array.from({ length: drops }, (_, j) => notice(notificationId(j + 1), watcher(j % listings), null,
      at(NOW.getTime() - 3_600_000 + j), 'Price dropped: "Bike"', listingId((j % listings) + 1)));
    db.seed('notifications', [...rows, ...(extra.last ?? [
      notice(HONEST_DROP, HONEST_WATCHER, null, at(NOW.getTime() - 60_000), 'Price dropped: "Honest bike"', HONEST_LISTING),
    ])]);
    return rows;
  }

  it('the owner\'s case: 1,000 drops across 500 listings, each saved by a different family, do not hold back another seller\'s drop: it goes out on the first tick, in a full batch', async () => {
    const drops = flood(500, 1000);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-honest-watcher');
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(PUSH_BATCH);
    // Non-vacuity: the flood is five batches, and nearly all of it still waits.
    expect(drops.filter((d) => !row(String(d.id)).pushed_at).length).toBeGreaterThan(1000 - PUSH_BATCH);
  });

  // The bound (the header's seller paragraph): on the first tick there is no
  // cursor, so one read reaches db-max-rows (1,000) rows. The seller's share
  // (10) is taken, forty drops are left out by name, and the rest are held
  // back: behind one drop more than a read reaches past, the honest drop waits
  // for the surplus, and goes out on the next tick, once the batch the surplus
  // took from the flood ahead of it is gone.
  it.each([
    [AT_THE_BOUND, 1],
    [AT_THE_BOUND + 1, 2],
  ])('%i listings, each saved by a different family, one drop each: another seller\'s drop behind them goes out on tick %i', async (listings, tick) => {
    flood(listings, listings);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(tick);
  });

  it('an ordinary notification behind a flood longer than a read reaches past still goes out on the first tick', async () => {
    const ORDINARY = notificationId(900_002);
    flood(2000, 2000, {
      families: ['fam-neighbour'],
      members: [member('fam-neighbour', 'u-neighbour')],
      devices: [device('phone-neighbour', 'u-neighbour')],
      last: [notice(ORDINARY, 'fam-neighbour', 'u-neighbour', at(NOW.getTime() - 60_000), 'Bin day')],
    });

    expect(await ticksUntilPushed(ORDINARY, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-neighbour');
  });

  // The recipient pass leaves the marketplace out too, once its own read that
  // far is filled: a parent's row in a family whose children filled its
  // family share is reached only there.
  it('a parent\'s row in a family its children\'s rows filled, behind a flood longer than a read reaches past, goes out on the first tick', async () => {
    const BUSY = 'fam-busy';
    const PARENT_ROW = notificationId(900_003);
    const children = ['u-c1', 'u-c2', 'u-c3', 'u-c4'];
    flood(2000, 2000, {
      families: [BUSY],
      members: [...children.map((c) => member(BUSY, c, 'child')), member(BUSY, 'u-parent')],
      devices: [device('phone-parent', 'u-parent')],
      last: [
        ...children.flatMap((c, k) => Array.from({ length: 15 }, (_, i) => notice(notificationId(800_000 + k * 100 + i), BUSY, c,
          at(NOW.getTime() - 120_000 + k * 100 + i), `Chore ${i}`))),
        notice(PARENT_ROW, BUSY, 'u-parent', at(NOW.getTime() - 60_000), 'School pickup moved'),
      ],
    });

    expect(await ticksUntilPushed(PARENT_ROW, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-parent');
  });
});

describe('a full seller\'s drops with no name left, read by read', () => {
  type R = { id: string; family_id: string; user_id: string | null; related_type: string | null; related_id: string | null; seller_family_id?: string | null };
  /** What an exclusion leaves out, written out here rather than imported. */
  const leftOut = (excluded: FairExclusion, r: R) => {
    if (excluded.families.includes(r.family_id)) return true;
    if (r.user_id) return excluded.recipients.includes(r.user_id);
    if (r.related_type === 'marketplace_listings') {
      return excluded.marketplace || excluded.landing.includes(r.family_id)
        || (r.related_id ? excluded.listings.includes(r.related_id) : excluded.unlisted);
    }
    return excluded.familyWide.includes(r.family_id);
  };
  /** A range that answers each read as PostgREST does, at most db-max-rows (1,000) rows. */
  const range = (rows: R[]) => {
    const calls: { size: number; excluded: FairExclusion }[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      calls.push({ size, excluded });
      return rows.filter((r) => !leftOut(excluded, r)).slice(0, Math.min(size, DB_MAX_ROWS));
    };
    return { read, calls };
  };
  const drop = (id: string, landing: string, listingName: string, seller: string): R =>
    ({ id, family_id: landing, user_id: null, related_type: 'marketplace_listings', related_id: listingName, seller_family_id: seller });
  /** One seller's drops, `perListing` to each of `listings` listings, each saved by a different family, in turn. */
  const broadFlood = (listings: number, perListing: number) =>
    Array.from({ length: listings * perListing }, (_, i) => drop(`d-${i}`, `w-${i % listings}`, `L${i % listings}`, 's'));
  const SHARES = {
    push: { size: PUSH_BATCH, perFamily: PUSH_ROWS_PER_FAMILY, perRecipient: PUSH_ROWS_PER_RECIPIENT },
    // deliverNotificationEmails reads no whole-family row, so no price drop
    // reaches it; this is the selector it shares, at its shares.
    email: { size: 500, perFamily: EMAIL_ROWS_PER_FAMILY, perRecipient: EMAIL_ROWS_PER_RECIPIENT },
  } as const;

  it.each(Object.entries(SHARES))('%s\'s shares: the owner\'s case, another seller\'s drop behind one seller\'s 1,000 drops across 500 listings and families, is in the batch', async (_name, { size, perFamily, perRecipient }) => {
    const { read, calls } = range([...broadFlood(500, 2), drop('other', 'z', 'honest-listing', 'honest-seller')]);
    const batch = await readFairBatch(read, size, { perFamily, perRecipient });
    expect(batch).toHaveLength(size);
    expect(batch.map((r) => r.id)).toContain('other');
    // The seller's share, and no more, while 'other' waited.
    expect(batch.slice(0, batch.findIndex((r) => r.id === 'other')).length).toBe(perRecipient);
    // The names stay as bounded as round 13 measured, and no read asks past db-max-rows.
    const named = size / perRecipient;
    expect(Math.max(...calls.map((c) => c.excluded.listings.length))).toBeLessThanOrEqual(named);
    expect(Math.max(...calls.map((c) => c.excluded.landing.length))).toBeLessThanOrEqual(named);
    expect(Math.max(...calls.map((c) => c.size))).toBe(DB_MAX_ROWS);
    expect(calls.length).toBeLessThanOrEqual(size / perFamily + 7 * named + 3 + 1 + 2);
  });

  it.each(Object.entries(SHARES))('%s\'s shares: the bound, to the row: behind one more held-back drop than a read reaches past, another seller\'s drop waits for the surplus', async (_name, { size, perFamily, perRecipient }) => {
    // Both name twenty listings and twenty landing families a batch, so the
    // rows not left out ahead of 'other' are (listings - 40) at either share.
    expect(size / perRecipient).toBe(PUSH_NAMED);
    const reached = async (listings: number) => {
      const { read } = range([...broadFlood(listings, 1), drop('other', 'z', 'honest-listing', 'honest-seller')]);
      return (await readFairBatch(read, size, { perFamily, perRecipient })).map((r) => r.id).includes('other');
    };
    expect(await reached(AT_THE_BOUND)).toBe(true);
    expect(await reached(AT_THE_BOUND + 1)).toBe(false);
  });

  // Push's later runs, with a cursor: each read keeps a quarter for the rows
  // behind it (aheadAndBehind, PUSH_RETRY_SHARE), so while both ranges fill
  // their part a read of 1,000 reaches 750 rows ahead and 250 behind. Here the
  // seller's drops are on both sides, the forty names spent behind (its rows
  // come first in a read), and 'other' sits on one side or the other.
  it.each([
    ['ahead of the cursor', 'ahead', 749],
    ['behind the cursor', 'behind', 289],
  ] as const)('the bound %s, to the row', async (_where, side, last) => {
    const flood = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => drop(`${prefix}-${i}`, `w${prefix}-${i}`, `${prefix}${i}`, 's'));
    const reached = async (before: number) => {
      const other = drop('other', 'z', 'honest-listing', 'honest-seller');
      const ahead = side === 'ahead' ? [...flood('A', before), other] : flood('A', 2000);
      const behind = side === 'behind' ? [...flood('B', before), other] : flood('B', 300);
      const ranges = aheadAndBehind(range(ahead).read, range(behind).read, PUSH_RETRY_SHARE);
      return (await readFairBatch(ranges.read, PUSH_BATCH, SHARES.push)).map((r) => r.id).includes('other');
    };
    expect(PUSH_RETRY_SHARE).toBe(0.25);
    expect(await reached(last)).toBe(true);
    expect(await reached(last + 1)).toBe(false);
  });

  it('a read that only holds drops back, its names spent by the read before, is followed by one that reaches past them', async () => {
    // Fifteen members' ten rows each, then the flood: the first read ends on
    // the seller's fiftieth drop, so the second holds back forty and names none.
    const members: R[] = Array.from({ length: 150 }, (_, i) => ({
      id: `m-${i}`, family_id: `f-${Math.floor(i / 10)}`, user_id: `u-${Math.floor(i / 10)}`, related_type: null, related_id: null,
    }));
    const { read, calls } = range([...members, ...broadFlood(200, 1), drop('other', 'z', 'honest-listing', 'honest-seller')]);
    const batch = await readFairBatch(read, PUSH_BATCH, SHARES.push);
    expect(batch.map((r) => r.id)).toContain('other');
    expect(calls.map((c) => c.size).slice(0, 3)).toEqual([PUSH_BATCH, PUSH_BATCH, DB_MAX_ROWS]);
    expect(calls[1].excluded.listings.length + calls[1].excluded.landing.length).toBe(2 * PUSH_NAMED);
    expect(calls[2].excluded).toEqual(calls[1].excluded);
  });

  it('control: a seller alone, its drops across more listings and families than the names hold, still goes out a full batch at a time', async () => {
    const { read } = range(broadFlood(500, 2));
    expect(await readFairBatch(read, PUSH_BATCH, SHARES.push)).toHaveLength(PUSH_BATCH);
  });

  it('ends when a read ignores the exclusion it was given, with drops held back', async () => {
    const rows = broadFlood(1500, 2);
    let reads = 0;
    const batch = await readFairBatch(async (size) => { reads += 1; return rows.slice(0, Math.min(size, DB_MAX_ROWS)); }, PUSH_BATCH, SHARES.push);
    expect(batch).toHaveLength(PUSH_BATCH);
    expect(reads).toBeLessThan(20);
  });
});
