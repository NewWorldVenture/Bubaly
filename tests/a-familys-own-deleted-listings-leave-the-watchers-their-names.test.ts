// household-roles round 12 (R11-RV1-OWN-DELETED-LISTINGS-SPEND-THE-SHARED-LISTING-NAMES):
// a family's own deleted listings do not spend the names a watcher family's
// price drops need.
//
// A seller is not a column of a notification, so a read leaves a full
// seller's price drops out by the narrowest name it can carry: the family they
// landed in when that is the seller's own, else the listing, else, once a
// bounded number of listing names is spent, the family they landed in, which
// then has every price drop into it wait, other sellers' honest ones too
// (lib/notifications/fair-batch.ts). Round 11 stopped taking the family a drop
// of a deleted listing landed in for its seller. So a child's own listings,
// saved in their own family, re-priced and deleted, were left out listing by
// listing, and spent the one pool of listing names that every seller's drops
// shared. Once it was spent, the same child's other listings, saved by a
// watcher family, had the watcher family named: its honest price drops waited
// eight ticks for the surplus pass. The same happened when those other
// listings were deleted too.
//
// Now the known sellers' drops and the drops not found count their listing
// names apart, and the drops not found that landed in one family name at most
// one family's listings, from a pool of twice that. Driven through the real
// dispatchPendingPushes on the in-memory database with PostgREST's row cap and
// the web-push mock live, one call per two-hourly tick; the last cases read
// the batch read by read.
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

const drop = (id: string, familyId: string, createdAt: string, listing: string, title = 'Price dropped: "Bike"'): Row => ({
  id, family_id: familyId, user_id: null, type: 'system', title, body: null,
  related_type: 'marketplace_listings', related_id: listing,
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

describe('push: a family\'s own deleted listings do not get a family that saved its others named', () => {
  const CHILD_FAMILY = 'fam-child';
  const WATCHER = 'fam-watcher';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_LISTING = listingId(99_999);
  const HONEST_DROP = notificationId(900_001);

  it.each([
    [30, 2, 'live'],
    [21, 2, 'live'],
    [30, 5, 'live'],
    [30, 2, 'deleted'],
    [30, 5, 'deleted'],
    // Round 13 (R12-RV2): more own deleted listings than the 40 listing names
    // the drops not found keep, so only the cap of 20 for the drops that
    // landed in one family leaves the watcher family its names.
    [50, 5, 'deleted'],
    [50, 15, 'deleted'],
  ] as const)('a child\'s %i own listings, saved in their family and deleted, with 100 drops each pending, and %i of their %s listings saved by a watcher family with 1,000 drops into it: another seller\'s drop into the watcher family goes out on the first tick', async (own, saved, state) => {
    db.seed('families', [CHILD_FAMILY, WATCHER, HONEST_SELLER].map(family));
    db.seed('family_members', [member(CHILD_FAMILY, 'u-child', 'child'), member(WATCHER, 'u-watcher'), member(HONEST_SELLER, 'u-honest')]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    // The child's own listings are gone; those the watcher family saved are
    // still there or gone too; the honest seller's is still there.
    db.seed('marketplace_listings', [
      listing(HONEST_LISTING, HONEST_SELLER),
      ...(state === 'live' ? Array.from({ length: saved }, (_, i) => listing(listingId(1000 + i), CHILD_FAMILY)) : []),
    ]);
    db.seed('notifications', [
      // The child's own deleted listings' drops, dated first.
      ...Array.from({ length: own * 100 }, (_, j) => drop(notificationId(j + 1), CHILD_FAMILY, at(NOW.getTime() - 7_200_000 + j), listingId((j % own) + 1))),
      // Their other listings' drops into the watcher family.
      ...Array.from({ length: 1000 }, (_, j) => drop(notificationId(100_000 + j), WATCHER, at(NOW.getTime() - 3_600_000 + j), listingId(1000 + (j % saved)))),
      drop(HONEST_DROP, WATCHER, at(NOW.getTime() - 60_000), HONEST_LISTING, 'Price dropped: "Honest bike"'),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-watcher');
    // Non-vacuity: the child's drops are many batches; most of them still wait.
    expect(db.table('notifications').filter((n) => n.family_id === CHILD_FAMILY && !n.pushed_at).length).toBeGreaterThan(own * 100 - 300);
    expect(db.table('notifications').filter((n) => n.family_id === WATCHER && n.id !== HONEST_DROP && !n.pushed_at).length).toBeGreaterThan(700);
  });

  it('control: with no deleted listings of their own, the watcher family\'s other drop went out on the first tick before as well', async () => {
    db.seed('families', [CHILD_FAMILY, WATCHER, HONEST_SELLER].map(family));
    db.seed('family_members', [member(CHILD_FAMILY, 'u-child', 'child'), member(WATCHER, 'u-watcher'), member(HONEST_SELLER, 'u-honest')]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    db.seed('marketplace_listings', [listing(HONEST_LISTING, HONEST_SELLER), listing(listingId(1000), CHILD_FAMILY), listing(listingId(1001), CHILD_FAMILY)]);
    db.seed('notifications', [
      ...Array.from({ length: 1000 }, (_, j) => drop(notificationId(100_000 + j), WATCHER, at(NOW.getTime() - 3_600_000 + j), listingId(1000 + (j % 2)))),
      drop(HONEST_DROP, WATCHER, at(NOW.getTime() - 60_000), HONEST_LISTING, 'Price dropped: "Honest bike"'),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
  });
});

// Round 13 (R12-RV2): the drops not found name their landing families from a
// pool of their own, not the known sellers'. One seller's listings, forty
// still there and sixty deleted, each saved by a different family: the known
// drops spend their twenty listing names and twenty landing names, and the
// drops not found theirs. Sharing one pool of landing names, the drops not
// found found it spent, were taken against their own listing's share alone,
// and filled the batch ahead of every watcher family's honest drop.
describe('push: one seller\'s drops into a hundred watcher families, forty of its listings live and sixty deleted', () => {
  it('the known drops and the drops not found each have at most twenty families wait, and every other watcher family\'s honest drop goes out on the first tick', async () => {
    const SELLER = 'fam-seller';
    const live = Array.from({ length: 40 }, (_, i) => `fam-live-${i}`);
    const gone = Array.from({ length: 60 }, (_, i) => `fam-gone-${i}`);
    const watchers = [...live, ...gone];
    // Each honest drop is another seller's, about a listing still there.
    const honestSeller = (w: string) => `${w}-seller`;
    db.seed('families', [SELLER, ...watchers, ...watchers.map(honestSeller)].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller', 'child'), ...watchers.map((w) => member(w, `u-${w}`))]);
    db.seed('push_devices', watchers.map((w) => device(`phone-${w}`, `u-${w}`)));
    db.seed('marketplace_listings', [
      ...live.map((_, i) => listing(listingId(1000 + i), SELLER)),
      ...watchers.map((w, i) => listing(listingId(50_000 + i), honestSeller(w))),
    ]);
    const flood: Row[] = [];
    let n = 0;
    for (let r = 0; r < 20; r += 1) {
      live.forEach((w, i) => { n += 1; flood.push(drop(notificationId(n), w, at(NOW.getTime() - 7_200_000 + n), listingId(1000 + i))); });
      gone.forEach((w, i) => { n += 1; flood.push(drop(notificationId(n), w, at(NOW.getTime() - 7_200_000 + n), listingId(1500 + i))); });
    }
    const honest = watchers.map((w, i) => drop(notificationId(800_000 + i), w, at(NOW.getTime() - 60_000 + i), listingId(50_000 + i), 'Price dropped: "Honest bike"'));
    db.seed('notifications', [...flood, ...honest]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    const waiting = (group: string[]) => honest.filter((h) => group.includes(String(h.family_id)) && !row(String(h.id)).pushed_at).length;
    expect(waiting(live), 'watcher families of the live listings left waiting').toBeLessThanOrEqual(20);
    expect(waiting(gone), 'watcher families of the deleted listings left waiting').toBeLessThanOrEqual(20);
    // Non-vacuity: the flood is ten batches, and most of it still waits.
    expect(flood.filter((d) => !row(String(d.id)).pushed_at).length).toBeGreaterThan(1500);
  });
});

describe('the listing names, read by read', () => {
  type FairExclusion = import('@/lib/notifications/fair-batch').FairExclusion;
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
  const range = (rows: R[]) => {
    const calls: FairExclusion[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      calls.push(excluded);
      return rows.filter((r) => !leftOut(excluded, r)).slice(0, size);
    };
    return { read, calls };
  };
  const priceDrop = (id: string, landing: string, listingName: string, seller: string | null): R =>
    ({ id, family_id: landing, user_id: null, related_type: 'marketplace_listings', related_id: listingName, seller_family_id: seller });
  /** A child's eight own listings, saved in their own family 'a' and deleted. */
  const ownDeleted = Array.from({ length: 40 }, (_, i) => priceDrop(`own-${i}`, 'a', `A${i % 8}`, null));
  // size 10, perFamily 6, perRecipient 3: a batch names 4 listings of a pool.
  const shares = { perFamily: 6, perRecipient: 3 };

  it('the drops not found that landed in one family name at most a family\'s listings, and leave the rest to a family that saved two of the child\'s deleted listings', async () => {
    const { read, calls } = range([
      ...ownDeleted,
      ...Array.from({ length: 20 }, (_, i) => priceDrop(`saved-${i}`, 'w', `M${i % 2}`, null)),
      priceDrop('honest', 'w', 'H', 't'),
    ]);
    const batch = await readFairBatch(read, 10, shares);
    expect(batch.map((r) => r.id)).toContain('honest');
    expect(calls.every((c) => !c.landing.includes('w'))).toBe(true);
    expect(calls.some((c) => c.listings.includes('M0') && c.listings.includes('M1'))).toBe(true);
    // The child's own family is named once its four listing names are spent.
    expect(calls.some((c) => c.landing.includes('a'))).toBe(true);
    expect(Math.max(...calls.map((c) => c.listings.filter((name) => name.startsWith('A')).length))).toBeLessThanOrEqual(4);
  });

  it('a known seller\'s drops into a watcher family keep their own listing names when the seller\'s own deleted listings have spent theirs', async () => {
    const { read, calls } = range([
      ...ownDeleted,
      ...Array.from({ length: 20 }, (_, i) => priceDrop(`saved-${i}`, 'w', `K${i % 2}`, 'a')),
      priceDrop('honest', 'w', 'H', 't'),
    ]);
    const batch = await readFairBatch(read, 10, shares);
    expect(batch.map((r) => r.id)).toContain('honest');
    expect(calls.every((c) => !c.landing.includes('w'))).toBe(true);
    expect(calls.some((c) => c.listings.includes('K0') && c.listings.includes('K1'))).toBe(true);
  });

  it('control, as in round 11: a family alone that saved twenty of a seller\'s deleted listings is still left out by listing, not named', async () => {
    const { read, calls } = range([
      ...Array.from({ length: 2000 }, (_, i) => priceDrop(`saved-${i}`, 'w', `L${i % 20}`, null)),
      priceDrop('honest', 'w', 'H', 't'),
    ]);
    const batch = await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 });
    expect(batch.map((r) => r.id)).toContain('honest');
    expect(calls.every((c) => !c.landing.includes('w'))).toBe(true);
    expect(Math.max(...calls.map((c) => c.listings.length))).toBe(20);
  });

  it('the names a read carries stay bounded as the header says when known sellers, drops not found and own families all flood at once', async () => {
    const rows: R[] = [];
    for (let i = 0; i < 1000; i += 1) {
      // A seller's 500 listings, each saved by a different family.
      rows.push(priceDrop(`known-${i}`, `w-${i % 500}`, `S${i % 500}`, 's'));
      // 500 deleted listings, each saved by a different family.
      rows.push(priceDrop(`gone-${i}`, `x-${i % 500}`, `G${i % 500}`, null));
      // A child's 30 deleted listings in their own family, and another's 30 live ones.
      if (i < 300) rows.push(priceDrop(`own-gone-${i}`, 'a', `A${i % 30}`, null));
      if (i < 300) rows.push(priceDrop(`own-live-${i}`, 'o', `O${i % 30}`, 'o'));
    }
    rows.push({ id: 'other', family_id: 'z', user_id: 'u-z', related_type: null, related_id: null });
    const { read, calls } = range(rows);
    const batch = await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 });
    expect(batch).toHaveLength(200);
    expect(batch.map((r) => r.id)).toContain('other');
    // 4 * size / perRecipient listings and 3 * size / perRecipient landing families at most.
    expect(Math.max(...calls.map((c) => c.listings.length))).toBeLessThanOrEqual(4 * 20);
    expect(Math.max(...calls.map((c) => c.landing.length))).toBeLessThanOrEqual(3 * 20);
    // The rounds: size / perFamily + 7 * size / perRecipient, plus one a pass and the marketplace.
    expect(calls.length).toBeLessThanOrEqual(5 + 7 * 20 + 3 + 1);
    // Both pools were drawn on: the known seller's listings and the deleted ones.
    expect(calls.some((c) => c.listings.some((name) => name.startsWith('S')) && c.listings.some((name) => name.startsWith('G')))).toBe(true);
  });
});
