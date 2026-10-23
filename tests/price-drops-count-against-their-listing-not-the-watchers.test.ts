// household-roles round 9 re-fix 1 (R9-RV1): a price drop counts against the
// listing that caused it, not against the family that receives it.
//
// 0191's marketplace_log_price_change writes one whole-family row
// (user_id null, related_type 'marketplace_listings', related_id the listing)
// into EACH family that saved the listing, on every price drop, and the
// listing's owner may PATCH its price up and down at will. Round 9 counted a
// whole-family row against the family that received it, so one seller's drops
// across twenty watcher families took twenty whole-family shares: the whole
// push batch, and every later family's due push waited. And in the seller's
// own family the drops took the family's whole-family share, so the family's
// own notice ('Family dinner at 6') queued behind them at ten rows a tick.
//
// Now every price drop is shared in one bucket of its own (the marketplace,
// with a family's share) and, inside it, by listing (with a recipient's share),
// whichever family it lands in (lib/notifications/fair-batch.ts). Making 0191
// notify watcher families only, at most once per listing a day, is the owner
// SQL that ends it.
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
const SELLER = 'fam-seller';
const NEIGHBOURS = 'fam-okafor';
/** Listing ids are uuids, as 0191 writes them into related_id. */
const listingId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const BIKE = listingId(1);
const at = (ms: number) => new Date(ms).toISOString();
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;

const notice = (
  id: string, familyId: string, userId: string | null, createdAt: string, title: string,
  related: { type: string; id: string | null } | null = null,
): Row => ({
  id, family_id: familyId, user_id: userId, type: 'system', title, body: null,
  related_type: related?.type ?? null, related_id: related?.id ?? null,
  is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
});
/** What 0191's trigger writes into one watcher family on each price drop of a listing it saved. */
const priceDrops = (count: number, familyId: string, listing: string | null, createdAt: (n: number) => string, from: number) =>
  Array.from({ length: count }, (_, i) => notice(notificationId(from + i), familyId, null, createdAt(i), 'Price dropped: "Bike"',
    { type: 'marketplace_listings', id: listing }));
const device = (id: string, userId: string): Row => ({
  id, user_id: userId, enabled: true, provider: 'webpush', platform: 'web', endpoint: `https://push.example.test/${id}`,
  p256dh: 'key', auth: 'auth', token: null, last_seen_at: '2026-10-01T00:00:00.000Z',
});
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;
const family = (id: string) => ({ id, timezone: 'UTC', closed_at: null });
const member = (familyId: string, userId: string, role = 'parent') =>
  ({ id: `m-${userId}`, family_id: familyId, user_id: userId, role, is_active: true });

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

describe('push: one seller\'s price drops across many watcher families take one share, not one a family', () => {
  /** Twenty-five families that saved the seller's listings, a parent and a phone each. */
  const WATCHERS = Array.from({ length: 25 }, (_, i) => `fam-watcher-${i}`);
  const PARENT_ROW = notificationId(90_001);
  const NEIGHBOUR_ROW = notificationId(90_002);
  function households() {
    db.seed('families', [...WATCHERS, SELLER, NEIGHBOURS].map(family));
    db.seed('family_members', [
      ...WATCHERS.map((id, i) => member(id, `u-watcher-${i}`)),
      member(SELLER, 'u-seller'),
      member(NEIGHBOURS, 'u-neighbour'),
    ]);
    db.seed('push_devices', [...WATCHERS.map((_, i) => device(`phone-watcher-${i}`, `u-watcher-${i}`)), device('phone-neighbour', 'u-neighbour')]);
  }
  /** The due rows the drops are dated ahead of: a watcher family's parent's, and the neighbours'. */
  const dueRows = () => [
    notice(PARENT_ROW, WATCHERS[0], 'u-watcher-0', at(NOW.getTime() - 60_000), 'Pick-up moved to 3pm'),
    notice(NEIGHBOUR_ROW, NEIGHBOURS, 'u-neighbour', at(NOW.getTime() - 30_000), 'Bin day tomorrow'),
  ];

  it.each([
    ['one listing', BIKE],
    // No writer leaves related_id null; such drops are still the marketplace's.
    ['no listing', null],
  ] as const)('forty drops naming %s in each of twenty-five watcher families do not hold back a neighbour\'s or a parent\'s due push on the first tick', async (_, listing) => {
    households();
    db.seed('notifications', [
      ...WATCHERS.flatMap((id, w) => priceDrops(40, id, listing, (n) => at(NOW.getTime() - 600_000 + w * 100 + n), 1 + w * 40)),
      ...dueRows(),
    ]);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(notifications).toBe(200);
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toEqual(expect.arrayContaining(['phone-neighbour', 'phone-watcher-0']));
    // Non-vacuity: the drops alone are five batches; most of them still wait.
    expect(db.table('notifications').filter((n) => n.related_type === 'marketplace_listings' && !n.pushed_at).length).toBeGreaterThan(700);
  });

  it('and on the next tick, reading both sides of the cursor, a fresh round of drops does not hold back a newly due neighbour\'s push', async () => {
    households();
    db.seed('notifications', [
      ...WATCHERS.flatMap((id, w) => priceDrops(40, id, BIKE, (n) => at(NOW.getTime() - 600_000 + w * 100 + n), 1 + w * 40)),
      ...dueRows(),
    ]);
    await dispatchPendingPushes(asDb(), { now: NOW });
    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    vi.setSystemTime(later);
    const NEXT_ROW = notificationId(90_003);
    // The seller drops a second listing's price forty times since: forty rows in each watcher family, ahead of the cursor.
    db.seed('notifications', [
      ...WATCHERS.flatMap((id, w) => priceDrops(40, id, listingId(2), (n) => at(later.getTime() - 600_000 + w * 100 + n), 2_001 + w * 40)),
      notice(NEXT_ROW, NEIGHBOURS, 'u-neighbour', at(later.getTime() - 30_000), 'Parents\' evening moved'),
    ]);
    providers.pushed = [];

    expect((await dispatchPendingPushes(asDb(), { now: later })).notifications).toBe(200);

    expect(row(NEXT_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toContain('phone-neighbour');
  });

  it('and a seller with many listings takes the marketplace\'s one share between them, not one a listing a family', async () => {
    households();
    // Eight listings, each saved by every watcher family, five drops of each into each: 1,000 rows.
    const listings = Array.from({ length: 8 }, (_, l) => listingId(l + 1));
    let from = 1;
    const drops: Row[] = [];
    for (const [w, id] of WATCHERS.entries()) {
      for (const [l, listing] of listings.entries()) {
        drops.push(...priceDrops(5, id, listing, (n) => at(NOW.getTime() - 600_000 + w * 100 + l * 10 + n), from));
        from += 5;
      }
    }
    db.seed('notifications', [...drops, ...dueRows()]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
  });

  it('control: with nobody else waiting, the drops still go out a full batch at a time', async () => {
    households();
    db.seed('notifications', WATCHERS.slice(0, 10).flatMap((id, w) =>
      priceDrops(30, id, BIKE, (n) => at(NOW.getTime() - 600_000 + w * 100 + n), 1 + w * 30)));

    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(200);
    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(100);
    expect(db.table('notifications').every((n) => n.pushed_at)).toBe(true);
  });
});

describe('push: a family\'s own whole-family notices are not queued behind its member\'s price drops', () => {
  const FAMILY = 'fam-rivera';
  const BUSY = 'fam-busy';
  const DINNER = notificationId(90_010);
  function households() {
    db.seed('families', [family(FAMILY), family(BUSY)]);
    db.seed('family_members', [
      member(FAMILY, 'u-parent'), member(FAMILY, 'u-child', 'child'),
      ...Array.from({ length: 20 }, (_, i) => member(BUSY, `u-busy-${i}`)),
    ]);
    db.seed('push_devices', [device('phone-parent', 'u-parent'), device('phone-child', 'u-child')]);
  }
  /** A busy family of twenty with 300 due rows of its own: it waits whatever this run takes. */
  const busyRows = () => Array.from({ length: 300 }, (_, i) =>
    notice(notificationId(50_000 + i), BUSY, `u-busy-${i % 20}`, at(NOW.getTime() - 1_800_000 + i), `Busy ${i}`));

  it.each([
    ['', BIKE],
    [', the drops naming no listing', null],
  ] as const)('a child who saves their own listing and drops its price 1,000 times does not hold back the family\'s own notice on the first tick, while another family waits%s', async (_, listing) => {
    households();
    db.seed('notifications', [
      ...priceDrops(1000, FAMILY, listing, (n) => at(NOW.getTime() - 3_600_000 + n), 1),
      ...busyRows(),
      notice(DINNER, FAMILY, null, at(NOW.getTime() - 60_000), 'Family dinner at 6'),
    ]);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(DINNER).pushed_at).toBeTruthy();
    expect(providers.pushed).toEqual(expect.arrayContaining(['phone-parent', 'phone-child']));
    // Other families were waiting: the batch was full, and some of the busy family's rows are left.
    expect(notifications).toBe(200);
    expect(db.table('notifications').some((n) => n.family_id === BUSY && !n.pushed_at)).toBe(true);
  });

  it('control: the family\'s own whole-family rows still share one recipient\'s share among themselves', async () => {
    households();
    db.seed('notifications', [
      ...Array.from({ length: 30 }, (_, i) => notice(notificationId(i + 1), FAMILY, null, at(NOW.getTime() - 3_600_000 + i), `Family notice ${i}`)),
      ...busyRows(),
    ]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    // Ten in the first pass; the busy family's members fill the rest of the batch before any surplus.
    const familyWide = db.table('notifications').filter((n) => n.family_id === FAMILY && n.pushed_at);
    expect(familyWide).toHaveLength(10);
  });
});

describe('the marketplace bucket, read by read', () => {
  type FairExclusion = import('@/lib/notifications/fair-batch').FairExclusion;
  type R = { id: string; family_id: string; user_id: string | null; related_type: string | null; related_id: string | null };
  /** What an exclusion leaves out, written out here rather than imported. */
  const leftOut = (excluded: FairExclusion, r: R) => {
    if (excluded.families.includes(r.family_id)) return true;
    if (r.user_id) return excluded.recipients.includes(r.user_id);
    if (r.related_type === 'marketplace_listings') {
      return excluded.marketplace || (r.related_id ? excluded.listings.includes(r.related_id) : excluded.unlisted);
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
  const drops = (familyId: string, listing: string | null, count: number, prefix: string): R[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, family_id: familyId, user_id: null, related_type: 'marketplace_listings', related_id: listing }));

  it('counts a listing\'s drops once across every family they land in, then the marketplace as one family', async () => {
    const { read, calls } = range([
      ...['a', 'b', 'c', 'd'].flatMap((f) => [...drops(f, 'L1', 5, `${f}1-`), ...drops(f, 'L2', 5, `${f}2-`), ...drops(f, 'L3', 5, `${f}3-`)]),
      { id: 'own', family_id: 'a', user_id: null, related_type: null, related_id: null },
      { id: 'other', family_id: 'z', user_id: 'u-z', related_type: null, related_id: null },
    ]);
    const batch = await readFairBatch(read, 10, { perFamily: 6, perRecipient: 3 });
    const ids = batch.map((r) => r.id);
    // Three of L1 and three of L2 fill the marketplace's six; the family's own notice and the other family's row come next.
    expect(ids.slice(0, 8).sort()).toEqual(['a1-0', 'a1-1', 'a1-2', 'a2-0', 'a2-1', 'a2-2', 'other', 'own'].sort());
    expect(calls.some((c) => c.marketplace)).toBe(true);
    expect(calls.some((c) => c.listings.includes('L1'))).toBe(true);
    expect(batch).toHaveLength(10);
  });

  it('drops that name no listing are still the marketplace\'s, and share one listing\'s share between them, not their families\'', async () => {
    const { read, calls } = range([
      ...['a', 'b', 'c'].flatMap((f) => drops(f, null, 10, `${f}-`)),
      { id: 'own', family_id: 'a', user_id: null, related_type: null, related_id: null },
      { id: 'other', family_id: 'z', user_id: 'u-z', related_type: null, related_id: null },
    ]);
    const batch = await readFairBatch(read, 8, { perFamily: 6, perRecipient: 3 });
    const ids = batch.map((r) => r.id);
    // Three drops in all, then the family's own notice and the other family's row, then the surplus.
    expect(ids.slice(0, 5).sort()).toEqual(['a-0', 'a-1', 'a-2', 'other', 'own'].sort());
    expect(calls.some((c) => c.unlisted && !c.familyWide.includes('a'))).toBe(true);
    expect(batch).toHaveLength(8);
  });
});
