// household-roles round 14, re-fix 1 (R14-RV1-BUSY-FAMILY-DROP-OUT-OF-REACH):
// another seller's price drop that lands in a family whose own rows fill its
// family share is reached past a full seller's held-back drops, like any other.
//
// Round 14 holds a full seller's drops back once the names a read can leave
// them out by are spent, and reads past them: up to FAIR_READ_MAX_ROWS rows,
// PostgREST's db-max-rows; once a read that far is still filled by rows taken
// or held, the marketplace is left out, so every family's own rows behind them
// are still reached (lib/notifications/fair-batch.ts, the seller paragraph).
// That was decided once, on the family pass's window, and carried into the
// recipient pass. But the family pass leaves out every row of a family at its
// share, the price drops that land in it included, and the recipient pass,
// which reads those rows again, is the only place such a drop can be taken.
// So a drop of another seller landing in a busy family, behind 150 of the
// flood's held-back drops (fewer than the 800 the header states) and outside
// the first read, was not in the batch: the recipient pass read with the
// marketplace already left out. It went out a tick later, and later still
// while the family stayed busy and the surplus worked through the flood
// ahead of it.
//
// Now each shared pass makes its own read that far before it leaves the
// marketplace out. Driven through the real dispatchPendingPushes on the
// in-memory database with PostgREST's row cap and the web-push mock live, one
// call per two-hourly tick; then read by read through readFairBatch, at push's
// shares and the email digest's, with the bound pinned to the row.
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

const { dispatchPendingPushes, PUSH_ROWS_PER_FAMILY, PUSH_ROWS_PER_RECIPIENT } = await import('@/lib/server/push');
const { EMAIL_ROWS_PER_FAMILY, EMAIL_ROWS_PER_RECIPIENT } = await import('@/lib/server/notification-emails');
const { readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
/** dispatchPendingPushes' batch, and the names a read keeps for a full seller's listings, and as many for their landing families. */
const PUSH_BATCH = 200;
const PUSH_NAMED = PUSH_BATCH / PUSH_ROWS_PER_RECIPIENT;
/** PostgREST's db-max-rows, the most rows one read may ask for and be answered in full (lib/supabase/read-all.ts). */
const DB_MAX_ROWS = 1000;
/** The flood's drops after the other seller's, more than a read reaches past. */
const FLOOD_BEHIND = 1100;
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

describe('push: another seller\'s drop into a family whose own rows fill its family share', () => {
  const BUSY = 'fam-busy';
  const QUIET = 'fam-quiet';
  const SELLER = 'fam-seller';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_LISTING = listingId(99_999);
  const OTHER = notificationId(900_001);
  /** Five members with a recipient's share each: one more than a family's share holds. */
  const BUSY_MEMBERS = ['u-b1', 'u-b2', 'u-b3', 'u-b4', 'u-b5'];
  const watcher = (i: number) => `fam-watcher-${i}`;

  /**
   * In created_at order: the busy family's members' rows, a recipient's share
   * each; then the seller's drops, each on its own listing saved by a
   * different family: its share, the forty a read names, and `held` more;
   * then another seller's drop landing in `landing`; then FLOOD_BEHIND more
   * of the seller's drops. The busy family has a parent with no rows of
   * their own, so their phone is buzzed only by a whole-family row.
   */
  function seed(held: number, landing: string) {
    const ahead = PUSH_ROWS_PER_RECIPIENT + 2 * PUSH_NAMED + held;
    const drops = ahead + FLOOD_BEHIND;
    const watchers = Array.from({ length: drops }, (_, i) => watcher(i));
    db.seed('families', [BUSY, QUIET, SELLER, HONEST_SELLER, ...watchers].map(family));
    db.seed('family_members', [
      ...BUSY_MEMBERS.map((u) => member(BUSY, u, 'child')), member(BUSY, 'u-busy-parent'),
      member(QUIET, 'u-quiet'), member(SELLER, 'u-seller', 'child'), member(HONEST_SELLER, 'u-honest'),
    ]);
    db.seed('push_devices', [device('phone-busy-parent', 'u-busy-parent'), device('phone-quiet', 'u-quiet')]);
    db.seed('marketplace_listings', [...watchers.map((_, i) => listing(listingId(i + 1), SELLER)), listing(HONEST_LISTING, HONEST_SELLER)]);
    const ordered: { id: string; familyId: string; userId: string | null; title: string; listed?: string }[] = [];
    const add = (id: string, familyId: string, userId: string | null, title: string, listed?: string) =>
      ordered.push({ id, familyId, userId, title, listed });
    BUSY_MEMBERS.forEach((u, k) => {
      for (let i = 0; i < PUSH_ROWS_PER_RECIPIENT; i += 1) add(notificationId(800_000 + k * 100 + i), BUSY, u, `Chore ${i}`);
    });
    for (let j = 0; j < drops; j += 1) {
      if (j === ahead) add(OTHER, landing, null, 'Price dropped: "Honest bike"', HONEST_LISTING);
      add(notificationId(j + 1), watcher(j), null, 'Price dropped: "Bike"', listingId(j + 1));
    }
    const start = NOW.getTime() - 3_600_000;
    db.seed('notifications', ordered.map((r, i) => notice(r.id, r.familyId, r.userId, at(start + i), r.title, r.listed)));
    return { ahead };
  }

  it('the busy family is one member over its family share, and the drop lies outside the first read', () => {
    expect(BUSY_MEMBERS.length * PUSH_ROWS_PER_RECIPIENT).toBe(PUSH_ROWS_PER_FAMILY + PUSH_ROWS_PER_RECIPIENT);
    const { ahead } = seed(150, BUSY);
    expect(BUSY_MEMBERS.length * PUSH_ROWS_PER_RECIPIENT + ahead).toBeGreaterThan(PUSH_BATCH);
  });

  it.each([150, 600])('behind %i held-back drops, under the 800 the header states: it goes out on the first tick', async (held) => {
    seed(held, BUSY);

    expect(await ticksUntilPushed(OTHER, 30)).toBe(1);
    // The parent has no row of their own: only the drop buzzes their phone.
    expect(providers.pushed).toContain('phone-busy-parent');
    // The busy family's members are all reached too, and the batch is full.
    for (let k = 0; k < BUSY_MEMBERS.length; k += 1) expect(row(notificationId(800_000 + k * 100)).pushed_at).toBeTruthy();
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(PUSH_BATCH);
  });

  it('control: the same drop landing in a family with no rows of its own goes out on the first tick', async () => {
    seed(600, QUIET);

    expect(await ticksUntilPushed(OTHER, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-quiet');
  });
});

describe('read by read: a drop into a family at its family share, behind held-back drops', () => {
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
  const SHARES = {
    push: { size: PUSH_BATCH, perFamily: PUSH_ROWS_PER_FAMILY, perRecipient: PUSH_ROWS_PER_RECIPIENT },
    // deliverNotificationEmails reads no whole-family row, so no price drop
    // reaches it; this is the selector it shares, at its shares.
    email: { size: 500, perFamily: EMAIL_ROWS_PER_FAMILY, perRecipient: EMAIL_ROWS_PER_RECIPIENT },
  } as const;
  type Shares = (typeof SHARES)[keyof typeof SHARES];
  /**
   * Per share: a number of held-back drops that puts the drop outside the
   * first read, and the most held-back drops the recipient pass still reaches
   * the drop past, to the row: its one read of 1,000 holds the busy family's
   * rows (a family's share and one recipient's more), the seller's share, the
   * held-back drops and the drop. Written out, not derived from fair-batch.ts,
   * so a read that asks for more or fewer rows fails here.
   */
  const CASES = { push: { outside: 150, atTheBound: 939 }, email: { outside: 400, atTheBound: 849 } } as const;

  /**
   * In order: family F's members (a family's share and one recipient's more),
   * a recipient's share each; seller s's drops on listings saved by different
   * families: its share, the names, and `held` more; another seller's drop
   * landing in `landing`; then FLOOD_BEHIND more of s's drops.
   */
  const rowsFor = ({ size, perFamily, perRecipient }: Shares, held: number, landing: string): R[] => {
    const members = perFamily / perRecipient + 1;
    const own: R[] = Array.from({ length: members * perRecipient }, (_, i) => ({
      id: `f-${i}`, family_id: 'F', user_id: `u-${Math.floor(i / perRecipient)}`, related_type: null, related_id: null,
    }));
    const ahead = perRecipient + 2 * (size / perRecipient) + held;
    const flood = Array.from({ length: ahead + FLOOD_BEHIND }, (_, i) => drop(`s-${i}`, `w-${i}`, `L${i}`, 's'));
    return [...own, ...flood.slice(0, ahead), drop('other', landing, 'honest-listing', 'honest-seller'), ...flood.slice(ahead)];
  };
  const batchOf = async (shares: Shares, held: number, landing: string) => {
    const { read, calls } = range(rowsFor(shares, held, landing));
    const batch = await readFairBatch(read, shares.size, { perFamily: shares.perFamily, perRecipient: shares.perRecipient });
    return { ids: batch.map((r) => r.id), calls };
  };

  it.each(Object.entries(SHARES))('%s\'s shares: the drop, outside the first read, is in the batch, which is full', async (name, shares) => {
    const { outside } = CASES[name as keyof typeof CASES];
    const { size, perFamily, perRecipient } = shares;
    // Non-vacuity: the first read ends before the drop.
    expect((perFamily + perRecipient) + perRecipient + 2 * (size / perRecipient) + outside).toBeGreaterThan(size);
    const { ids, calls } = await batchOf(shares, outside, 'F');
    expect(ids).toHaveLength(size);
    expect(ids).toContain('other');
    // Every row of F is in the batch too: its family share in the family pass, the rest in the recipient pass.
    expect(ids.filter((id) => id.startsWith('f-'))).toHaveLength(perFamily + perRecipient);
    expect(Math.max(...calls.map((c) => c.size))).toBe(DB_MAX_ROWS);
    const named = size / perRecipient;
    expect(Math.max(...calls.map((c) => c.excluded.listings.length))).toBeLessThanOrEqual(named);
    expect(Math.max(...calls.map((c) => c.excluded.landing.length))).toBeLessThanOrEqual(named);
  });

  it.each(Object.entries(SHARES))('%s\'s shares: the bound, to the row: behind one more held-back drop than the recipient pass reaches past, the drop waits for the surplus', async (name, shares) => {
    const { atTheBound } = CASES[name as keyof typeof CASES];
    expect((await batchOf(shares, atTheBound, 'F')).ids).toContain('other');
    expect((await batchOf(shares, atTheBound + 1, 'F')).ids).not.toContain('other');
  });

  it('push\'s shares: 600 held-back drops ahead, under the 800 the header states: the drop is in the batch', async () => {
    expect((await batchOf(SHARES.push, 600, 'F')).ids).toContain('other');
  });

  it('control: the same drop landing in a family that is not at its share is in the batch', async () => {
    expect((await batchOf(SHARES.push, CASES.push.outside, 'z')).ids).toContain('other');
    expect((await batchOf(SHARES.push, 600, 'z')).ids).toContain('other');
  });
});
