// household-roles round 11 (R10-RV1-DELETED-LISTINGS-NAME-THE-WATCHER-FAMILY):
// the price drops of a listing that is not found share a bucket of their own,
// not the family they landed in.
//
// Round 10 counted each of 0191's price drops against its listing and its
// seller, the family whose listing it is (lib/notifications/fair-batch.ts).
// When the listing was not found (0154 lets its owner delete it, and its
// pending drops stay, related_id being text with no foreign key; or the
// lookup failed), the seller fell back to the family the drop landed in. So a
// watcher family that saved two of a seller's listings, since deleted, was
// taken for the seller of their drops, was named in every read, and every
// other price drop into it, other sellers' honest ones too, waited for the
// surplus pass, five ticks behind the backlog. The same fallback counted those
// drops against the watcher family's own seller share, so the family's own
// listing's drops into its watchers waited too, and a seller who deleted
// listings saved by twenty families got twenty shares back.
//
// Now a drop whose listing is not found counts against the drops not found of
// the family it landed in, which no seller's drops share, and all the drops
// not found together take one family's share at most. Driven through the real
// dispatchPendingPushes on the in-memory database with PostgREST's row cap
// and the web-push mock live, one call per two-hourly tick; the last cases
// read the batch read by read.
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

describe('push: drops of a deleted listing do not name the watcher family they landed in', () => {
  const WATCHER = 'fam-watcher';
  const SELLER = 'fam-seller';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_LISTING = listingId(99_999);
  const HONEST_DROP = notificationId(900_001);

  it.each([2, 5])('a family that saved %i of a seller\'s listings, deleted since with 1,000 drops into it pending, still gets another seller\'s price drop on the first tick', async (listings) => {
    db.seed('families', [WATCHER, SELLER, HONEST_SELLER].map(family));
    db.seed('family_members', [member(WATCHER, 'u-watcher'), member(SELLER, 'u-seller'), member(HONEST_SELLER, 'u-honest')]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    // The seller's listings are gone; the honest seller's is still there.
    db.seed('marketplace_listings', [listing(HONEST_LISTING, HONEST_SELLER)]);
    db.seed('notifications', [
      ...Array.from({ length: 1000 }, (_, j) => drop(notificationId(j + 1), WATCHER, at(NOW.getTime() - 3_600_000 + j), listingId((j % listings) + 1))),
      drop(HONEST_DROP, WATCHER, at(NOW.getTime() - 60_000), HONEST_LISTING, 'Price dropped: "Honest bike"'),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-watcher');
    // Non-vacuity: the deleted listings' drops are five batches; most of them still wait.
    expect(db.table('notifications').filter((n) => n.id !== HONEST_DROP && !n.pushed_at).length).toBeGreaterThan(700);
  });

  it('they do not take the share of the family they landed in as a seller: its own listing\'s drop into a family watching it goes out on the first tick', async () => {
    // The watcher family sells a pram of its own, saved by a neighbour.
    const NEIGHBOUR = 'fam-neighbour';
    const PRAM = listingId(88_888);
    const PRAM_DROP = notificationId(900_002);
    db.seed('families', [WATCHER, SELLER, NEIGHBOUR].map(family));
    db.seed('family_members', [member(WATCHER, 'u-watcher'), member(SELLER, 'u-seller'), member(NEIGHBOUR, 'u-neighbour')]);
    db.seed('push_devices', [device('phone-neighbour', 'u-neighbour')]);
    db.seed('marketplace_listings', [listing(PRAM, WATCHER)]);
    db.seed('notifications', [
      ...Array.from({ length: 1000 }, (_, j) => drop(notificationId(j + 1), WATCHER, at(NOW.getTime() - 3_600_000 + j), listingId((j % 2) + 1))),
      drop(PRAM_DROP, NEIGHBOUR, at(NOW.getTime() - 60_000), PRAM, 'Price dropped: "Pram"'),
    ]);

    expect(await ticksUntilPushed(PRAM_DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-neighbour');
  });

  it('a seller\'s twenty listings, each saved by a different family and deleted since, take one family\'s share between them, not one share a family: another seller\'s drop goes out on the first tick', async () => {
    const WATCHERS = Array.from({ length: 20 }, (_, i) => `fam-watcher-${i}`);
    const HONEST_WATCHER = 'fam-honest-watcher';
    db.seed('families', [SELLER, HONEST_SELLER, HONEST_WATCHER, ...WATCHERS].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller'), member(HONEST_SELLER, 'u-honest'), member(HONEST_WATCHER, 'u-honest-watcher'),
      ...WATCHERS.map((id, i) => member(id, `u-watcher-${i}`))]);
    db.seed('push_devices', [device('phone-honest-watcher', 'u-honest-watcher')]);
    db.seed('marketplace_listings', [listing(HONEST_LISTING, HONEST_SELLER)]);
    db.seed('notifications', [
      ...Array.from({ length: 2000 }, (_, j) => drop(notificationId(j + 1), WATCHERS[j % 20], at(NOW.getTime() - 3_600_000 + j), listingId((j % 20) + 1))),
      drop(HONEST_DROP, HONEST_WATCHER, at(NOW.getTime() - 60_000), HONEST_LISTING, 'Price dropped: "Honest bike"'),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(db.table('notifications').filter((n) => n.id !== HONEST_DROP && !n.pushed_at).length).toBeGreaterThan(1700);
  });

  it('control: a child\'s thirty deleted listings, saved in their own family, are still left out by that family once the listing names are spent, and another family\'s drop goes out on the first tick', async () => {
    const CHILD_FAMILY = 'fam-child';
    db.seed('families', [CHILD_FAMILY, WATCHER, HONEST_SELLER].map(family));
    db.seed('family_members', [member(CHILD_FAMILY, 'u-child', 'child'), member(WATCHER, 'u-watcher'), member(HONEST_SELLER, 'u-honest')]);
    db.seed('push_devices', [device('phone-watcher', 'u-watcher')]);
    db.seed('marketplace_listings', [listing(HONEST_LISTING, HONEST_SELLER)]);
    db.seed('notifications', [
      ...Array.from({ length: 3000 }, (_, j) => drop(notificationId(j + 1), CHILD_FAMILY, at(NOW.getTime() - 3_600_000 + j), listingId((j % 30) + 1))),
      drop(HONEST_DROP, WATCHER, at(NOW.getTime() - 60_000), HONEST_LISTING, 'Price dropped: "Honest bike"'),
    ]);

    expect(await ticksUntilPushed(HONEST_DROP, 30)).toBe(1);
    expect(db.table('notifications').filter((n) => n.family_id === CHILD_FAMILY && !n.pushed_at).length).toBeGreaterThan(2700);
  });
});

describe('the drops not found, read by read', () => {
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
  const priceDrop = (id: string, landing: string, listing: string, seller: string | null): R =>
    ({ id, family_id: landing, user_id: null, related_type: 'marketplace_listings', related_id: listing, seller_family_id: seller });

  it('a full share of drops not found is left out by its listings, not by the family it landed in, while the names last', async () => {
    const { read, calls } = range([
      ...Array.from({ length: 60 }, (_, i) => priceDrop(`gone-${i}`, 'w', `L${i % 2}`, null)),
      priceDrop('honest', 'w', 'H', 't'),
    ]);
    const batch = await readFairBatch(read, 10, { perFamily: 6, perRecipient: 3 });
    expect(batch.slice(0, 4).map((r) => r.id)).toEqual(['gone-0', 'gone-1', 'gone-2', 'honest']);
    expect(calls.every((c) => !c.landing.includes('w'))).toBe(true);
    expect(calls.some((c) => c.listings.includes('L0') && c.listings.includes('L1'))).toBe(true);
  });

  it('the names a read carries for drops not found stay bounded however many listings and families they landed in', async () => {
    const { read, calls } = range([
      ...Array.from({ length: 1000 }, (_, i) => priceDrop(`d-${i}`, `w-${i % 500}`, `L${i % 500}`, null)),
      { id: 'other', family_id: 'z', user_id: 'u-z', related_type: null, related_id: null },
    ]);
    const batch = await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 });
    expect(batch).toHaveLength(200);
    expect(batch.map((r) => r.id)).toContain('other');
    expect(Math.max(...calls.map((c) => c.listings.length))).toBeLessThanOrEqual(20 + 20);
    expect(Math.max(...calls.map((c) => c.landing.length))).toBeLessThanOrEqual(20 + 20);
    expect(calls.length).toBeLessThan(100);
  });
});
