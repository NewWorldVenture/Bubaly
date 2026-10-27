// household-roles round 10 (R9-RV2-ONE-SELLERS-LISTINGS-TAKE-EVERY-BATCH-AHEAD-OF-OTHER-SELLERS-PRICE-DROPS,
// R9-RV2-MARKETPLACE-EXCLUSION-READ-UNPINNED): a price drop counts against the
// family whose listing it is, so one family's listings together take one
// recipient's share of a push batch, however many listings it has.
//
// Round 9's re-fix shared 0191's whole-family price drops by LISTING inside
// one marketplace share. 0154 lets any member create listings, save them in
// their own family and re-price them at will, so one child with twenty
// listings had twenty recipient shares: once nobody else was waiting, their
// drops took the whole batch, in created_at order, ahead of every other
// family's price drop, about 200 rows a tick for as long as the backlog
// ahead of it lasted. No outside watcher was needed.
//
// Now dispatch resolves each drop's listing to its family (the seller) and a
// drop counts against both its listing and its seller (lib/server/push.ts,
// lib/notifications/fair-batch.ts). Driven through the real
// dispatchPendingPushes on the in-memory database with PostgREST's row cap and
// the web-push mock live, one call per two-hourly tick. The owner SQL for 0191
// (notify watcher families only, at most once per listing a day) is still
// what ends the flood.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
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

const { dispatchPendingPushes } = await import('@/lib/server/push');
const { readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
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

describe('push: a child\'s own listings, saved in their own family, take one share between them', () => {
  /** The child's family, an honest seller, the family watching the honest listing, and five other busy families. */
  const CHILD_FAMILY = 'fam-child';
  const HONEST_SELLER = 'fam-honest';
  const WATCHER = 'fam-watcher';
  const OTHERS = Array.from({ length: 5 }, (_, i) => `fam-other-${i}`);
  const HONEST_LISTING = listingId(99_999);
  const HONEST_DROP = notificationId(900_002);
  function households(listings: number, listingsKnown: boolean) {
    db.seed('families', [CHILD_FAMILY, HONEST_SELLER, WATCHER, ...OTHERS].map(family));
    db.seed('family_members', [
      member(CHILD_FAMILY, 'u-child', 'child'), member(HONEST_SELLER, 'u-honest'), member(WATCHER, 'u-watcher'),
      ...OTHERS.map((id, i) => member(id, `u-other-${i}`)),
    ]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    // A listing deleted since its drops were written is not found; its drops
    // count against the family they landed in, here the child's own.
    db.seed('marketplace_listings', listingsKnown ? [
      ...Array.from({ length: listings }, (_, l) => listing(listingId(l + 1), CHILD_FAMILY)),
      listing(HONEST_LISTING, HONEST_SELLER),
    ] : []);
  }
  /** Fifty rows of the other families that wait on the first tick. */
  const othersWaiting = () => Array.from({ length: 50 }, (_, i) =>
    notice(notificationId(500_000 + i), OTHERS[i % 5], `u-other-${i % 5}`, at(NOW.getTime() - 120_000 + i), `Other ${i}`));

  it.each([
    [20, 200, true], [100, 40, true], [20, 200, false],
  ] as const)('%i listings of %i drops each, spread over ten hours (listings found: %s), do not hold back an honest drop dated in the middle of them: it goes out on the first tick', async (listings, per, known) => {
    households(listings, known);
    const total = listings * per;
    const span = 10 * 3_600_000;
    const drops = Array.from({ length: total }, (_, j) => notice(notificationId(j + 1), CHILD_FAMILY, null,
      at(NOW.getTime() - span + Math.floor((j * (span - 60_000)) / total)), 'Price dropped: "Bike"', listingId((j % listings) + 1)));
    db.seed('notifications', [
      ...drops, ...othersWaiting(),
      notice(HONEST_DROP, WATCHER, null, at(NOW.getTime() - span / 2 + 7), 'Price dropped: "Honest bike"', HONEST_LISTING),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-watcher');
    // Non-vacuity: the child's drops are many batches; nearly all of them still wait.
    expect(db.table('notifications').filter((n) => n.family_id === CHILD_FAMILY && !n.pushed_at).length).toBeGreaterThan(total - 200);
  });

  it.each([40, 150, 400])('%i drops of each of twenty listings, all dated before the honest drop, do not hold it back: it goes out on the first tick, with the others\' rows', async (per) => {
    households(20, true);
    const drops = Array.from({ length: 20 * per }, (_, j) => notice(notificationId(j + 1), CHILD_FAMILY, null,
      at(NOW.getTime() - 36_000_000 + j), 'Price dropped: "Bike"', listingId((j % 20) + 1)));
    db.seed('notifications', [
      ...drops, ...othersWaiting(),
      notice(HONEST_DROP, WATCHER, null, at(NOW.getTime() - 60_000), 'Price dropped: "Honest bike"', HONEST_LISTING),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(othersWaiting().every((n) => row(String(n.id)).pushed_at)).toBe(true);
  });

  it('control: with nobody else waiting, the child\'s drops still go out a full batch at a time', async () => {
    households(20, true);
    db.seed('notifications', Array.from({ length: 300 }, (_, j) => notice(notificationId(j + 1), CHILD_FAMILY, null,
      at(NOW.getTime() - 3_600_000 + j), 'Price dropped: "Bike"', listingId((j % 20) + 1))));

    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(200);
    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(100);
    expect(db.table('notifications').every((n) => n.pushed_at)).toBe(true);
  });
});

describe('push: a seller\'s listings saved by other families take one share between them too', () => {
  const SELLER = 'fam-seller';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_LISTING = listingId(99_999);
  const HONEST_DROP = notificationId(900_003);
  /** Twenty families that each saved one of the seller's twenty listings, and one that saved an honest listing. */
  const WATCHERS = Array.from({ length: 20 }, (_, i) => `fam-watcher-${i}`);
  const HONEST_WATCHER = 'fam-honest-watcher';

  it('twenty listings, each saved by a different family, with a hundred drops each, do not hold back another seller\'s drop on the first tick', async () => {
    db.seed('families', [SELLER, HONEST_SELLER, HONEST_WATCHER, ...WATCHERS].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller'), member(HONEST_SELLER, 'u-honest'), member(HONEST_WATCHER, 'u-honest-watcher'),
      ...WATCHERS.map((id, i) => member(id, `u-watcher-${i}`))]);
    db.seed('push_devices', [device('phone-honest-watcher', 'u-honest-watcher')]);
    db.seed('marketplace_listings', [...WATCHERS.map((_, i) => listing(listingId(i + 1), SELLER)), listing(HONEST_LISTING, HONEST_SELLER)]);
    db.seed('notifications', [
      ...Array.from({ length: 2000 }, (_, j) => notice(notificationId(j + 1), WATCHERS[j % 20], null,
        at(NOW.getTime() - 3_600_000 + j), 'Price dropped: "Bike"', listingId((j % 20) + 1))),
      notice(HONEST_DROP, HONEST_WATCHER, null, at(NOW.getTime() - 60_000), 'Price dropped: "Honest bike"', HONEST_LISTING),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(db.table('notifications').filter((n) => n.family_id !== HONEST_WATCHER && !n.pushed_at).length).toBeGreaterThan(1800);
  });

  // A control against round 9 (the listing's share held this too), and the pin
  // on the seller lookup: with the seller unknown, both listings' drops would
  // count against the family they land in, and the seller's thousand, ahead,
  // would leave that family's drops out until the surplus.
  it('a family that saved a seller\'s listing still gets another seller\'s price drop on the first tick behind that seller\'s thousand', async () => {
    const WATCHER = WATCHERS[0];
    db.seed('families', [SELLER, HONEST_SELLER, WATCHER].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller'), member(HONEST_SELLER, 'u-honest'), member(WATCHER, 'u-watcher')]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    db.seed('marketplace_listings', [listing(listingId(1), SELLER), listing(HONEST_LISTING, HONEST_SELLER)]);
    db.seed('notifications', [
      ...Array.from({ length: 1000 }, (_, j) => notice(notificationId(j + 1), WATCHER, null,
        at(NOW.getTime() - 3_600_000 + j), 'Price dropped: "Bike"', listingId(1))),
      notice(HONEST_DROP, WATCHER, null, at(NOW.getTime() - 60_000), 'Price dropped: "Honest bike"', HONEST_LISTING),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
  });
});

describe('push: the marketplace\'s own share is left out of the read once it is full (R9-RV2-MARKETPLACE-EXCLUSION-READ-UNPINNED)', () => {
  it('fifty listings of fifty sellers, ten drops each, all saved by one family, do not hold back a neighbour\'s due push on the first tick', async () => {
    // Every listing and every seller is inside its own share: only the
    // marketplace's family share is full after four of them, so only the read
    // that leaves the marketplace out reaches the neighbour in the first pass.
    // Without it (push.ts's `if (excluded.marketplace) q = q.or(notMarket)`),
    // the first pass's reads come back full of drops it may not take, the
    // pass ends, and the next gives listings five to twenty their ten each.
    const sellers = Array.from({ length: 50 }, (_, i) => `fam-seller-${i}`);
    db.seed('families', ['fam-watcher', 'fam-neighbour', ...sellers].map(family));
    db.seed('family_members', [member('fam-watcher', 'u-watcher'), member('fam-neighbour', 'u-neighbour')]);
    db.seed('push_devices', [device('phone-neighbour', 'u-neighbour')]);
    db.seed('marketplace_listings', sellers.map((id, i) => listing(listingId(i + 1), id)));
    const NEIGHBOUR_ROW = notificationId(90_001);
    db.seed('notifications', [
      ...Array.from({ length: 500 }, (_, k) => notice(notificationId(k + 1), 'fam-watcher', null,
        at(NOW.getTime() - 3_600_000 + k), 'Price dropped', listingId(Math.floor(k / 10) + 1))),
      notice(NEIGHBOUR_ROW, 'fam-neighbour', 'u-neighbour', at(NOW.getTime() - 60_000), 'Bin day'),
    ]);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(notifications).toBe(200);
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toContain('phone-neighbour');
  });
});

describe('the seller share, read by read', () => {
  type FairExclusion = import('@/lib/notifications/fair-batch').FairExclusion;
  type R = { id: string; family_id: string; user_id: string | null; related_type: string | null; related_id: string | null; seller_family_id?: string | null };
  /** What an exclusion leaves out, written out here rather than imported. */
  const leftOut = (excluded: FairExclusion, r: R) => {
    if (!r.user_id && r.related_type === 'marketplace_listings') {
      return excluded.marketplace || excluded.landing.includes(r.family_id)
        || (r.related_id ? excluded.listings.includes(r.related_id) : excluded.unlisted);
    }
    if (excluded.families.includes(r.family_id)) return true;
    if (r.user_id) return excluded.recipients.includes(r.user_id);
    return excluded.familyWide.includes(r.family_id);
  };
  const range = (rows: R[]) => {
    const calls: FairExclusion[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      calls.push(excluded);
      return rows.filter((r) => !leftOut(excluded, r)).slice(0, size);
    };
    return { read, calls };
  };
  const drop = (id: string, landing: string, listing: string, seller: string): R =>
    ({ id, family_id: landing, user_id: null, related_type: 'marketplace_listings', related_id: listing, seller_family_id: seller });

  it('a seller\'s drops into its own family are left out by that family, however many listings they name', async () => {
    const { read, calls } = range([
      ...Array.from({ length: 60 }, (_, i) => drop(`own-${i}`, 's', `L${i % 30}`, 's')),
      drop('honest', 'w', 'H', 't'),
    ]);
    const batch = await readFairBatch(read, 10, { perFamily: 6, perRecipient: 3 });
    expect(batch.slice(0, 4).map((r) => r.id)).toEqual(['own-0', 'own-1', 'own-2', 'honest']);
    expect(calls.some((c) => c.landing.includes('s') && c.listings.length === 0)).toBe(true);
  });

  it('the names a read carries for full sellers stay bounded however many listings and watcher families a seller has', async () => {
    // One seller, 500 listings, each saved by a different family, two drops each.
    const { read, calls } = range([
      ...Array.from({ length: 1000 }, (_, i) => drop(`d-${i}`, `w-${i % 500}`, `L${i % 500}`, 's')),
      { id: 'other', family_id: 'z', user_id: 'u-z', related_type: null, related_id: null },
    ]);
    const batch = await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 });
    expect(batch).toHaveLength(200);
    expect(batch.map((r) => r.id)).toContain('other');
    // Twenty listings and twenty landing families by name at most, as the header says.
    expect(Math.max(...calls.map((c) => c.listings.length))).toBeLessThanOrEqual(20 + 20);
    expect(Math.max(...calls.map((c) => c.landing.length))).toBeLessThanOrEqual(20 + 20);
    expect(calls.length).toBeLessThan(100);
  });

  // household-roles round 14 (OWNER-R14-EXHAUSTED-NAMES-LIFT-SELLER-SHARE): the
  // owner's reproduction on PR #1131. The case above, with its last row
  // another seller's price drop in place of an ordinary notification, and
  // every assertion kept. Once the seller's twenty listing and twenty landing
  // names were spent, its further drops were taken against their own
  // listing's share alone, and the batch filled from its flood, 'other'
  // missing. Now a full seller's drops wait however many names are spent, and
  // the read reaches past those it cannot leave out.
  it('another seller\'s price drop behind the same flood, once the names are spent, is still in the batch', async () => {
    const { read, calls } = range([
      ...Array.from({ length: 1000 }, (_, i) => drop(`d-${i}`, `w-${i % 500}`, `L${i % 500}`, 's')),
      drop('other', 'z', 'honest-listing', 'honest-seller'),
    ]);
    const batch = await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 });
    expect(batch).toHaveLength(200);
    expect(batch.map((r) => r.id)).toContain('other');
    expect(Math.max(...calls.map((c) => c.listings.length))).toBeLessThanOrEqual(20 + 20);
    expect(Math.max(...calls.map((c) => c.landing.length))).toBeLessThanOrEqual(20 + 20);
    expect(calls.length).toBeLessThan(100);
  });
});
