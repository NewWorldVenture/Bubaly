// household-roles round 15 (R14-RV2-DROP-INTO-FULL-FAMILY-WAITS-FOR-SURPLUS):
// a price drop that lands in a family at its family share is taken in the
// family pass, against the marketplace's share, not left out with that family.
//
// A batch is shared by family first, and a price drop is no family's: it is
// shared as the marketplace, whichever family it lands in, and takes none of
// the share of the family it lands in (lib/notifications/fair-batch.ts, WHAT
// THIS BOUNDS). But the family pass left out every row of a family at its
// share, the drops landing in it included (isExcluded, and push's read with
// `family_id=not.in.(...)`). So such a drop was reached only in the recipient
// pass, in created_at order alongside every family's surplus: with no flood at
// all, a busy family F at its share and thirty members of another family R
// with ten rows each ahead of it, the batch was F 50, R 150, and the drop,
// with the marketplace at none of its 40, went out a tick later. R's members
// may each plant their own rows (0388's notif_insert), so a family with many
// member accounts could delay another family's incoming drop whenever the
// family it landed in was at its share.
//
// Now a family at its share is left out of the family pass but for the price
// drops that land in it, in isExcluded and in push's read alike. Driven
// through the real dispatchPendingPushes on the in-memory database with
// PostgREST's row cap and the web-push mock live; then read by read through
// readFairBatch at push's shares, the reviewer's reproductions.
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
const { isExcluded, readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
/** dispatchPendingPushes' batch. */
const PUSH_BATCH = 200;
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

describe('push: an honest seller\'s drop into a family at its share, another family\'s surplus ahead of it', () => {
  const BUSY = 'fam-busy';
  const QUIET = 'fam-quiet';
  const HONEST_SELLER = 'fam-honest';
  const HONEST_LISTING = listingId(1);
  const DROP = notificationId(900_001);
  /** Five members with a recipient's share each: one more than a family's share holds. */
  const BUSY_MEMBERS = 5;

  /**
   * In created_at order: `busy` families' members' rows, ten each, then the
   * honest seller's drop landing in `landing`. Each busy family's first
   * member is a parent with a phone; the rest are children with none. BUSY
   * also has a parent with a phone and no rows of their own, so their phone is
   * buzzed only by a whole-family row.
   */
  function seed(busy: { id: string; members: number }[], landing: string) {
    db.seed('families', [BUSY, QUIET, HONEST_SELLER, ...busy.map((b) => b.id)].map(family));
    const members: Row[] = [member(BUSY, 'u-busy-parent'), member(QUIET, 'u-quiet'), member(HONEST_SELLER, 'u-honest')];
    const rows: { id: string; familyId: string; userId: string | null; title: string; listed?: string }[] = [];
    busy.forEach((b, f) => {
      for (let k = 0; k < b.members; k += 1) {
        const userId = `u-${b.id}-${k}`;
        members.push(member(b.id, userId, 'child'));
        for (let i = 0; i < PUSH_ROWS_PER_RECIPIENT; i += 1) rows.push({ id: notificationId(100_000 * (f + 1) + k * 100 + i), familyId: b.id, userId, title: `Chore ${i}` });
      }
    });
    rows.push({ id: DROP, familyId: landing, userId: null, title: 'Price dropped: "Honest bike"', listed: HONEST_LISTING });
    db.seed('family_members', members);
    db.seed('push_devices', [device('phone-busy-parent', 'u-busy-parent'), device('phone-quiet', 'u-quiet')]);
    db.seed('marketplace_listings', [{ id: HONEST_LISTING, family_id: HONEST_SELLER, title: 'Bike', price_cents: 5000, status: 'available' }]);
    const start = NOW.getTime() - 3_600_000;
    db.seed('notifications', rows.map((r, i) => notice(r.id, r.familyId, r.userId, at(start + i), r.title, r.listed)));
  }
  const pushedOf = (familyId: string) => db.table('notifications').filter((n) => n.pushed_at && n.family_id === familyId && !n.related_type).length;

  it('the busy family is one member over its family share, and the other family\'s rows fill the batch\'s rest', () => {
    expect(BUSY_MEMBERS * PUSH_ROWS_PER_RECIPIENT).toBe(PUSH_ROWS_PER_FAMILY + PUSH_ROWS_PER_RECIPIENT);
    expect(BUSY_MEMBERS * PUSH_ROWS_PER_RECIPIENT + 30 * PUSH_ROWS_PER_RECIPIENT).toBeGreaterThan(PUSH_BATCH);
  });

  it('busy family F at its share, thirty members of R with ten rows each, then the drop into F: it goes out on the first tick', async () => {
    seed([{ id: BUSY, members: BUSY_MEMBERS }, { id: 'fam-r', members: 30 }], BUSY);

    expect(await ticksUntilPushed(DROP, 30)).toBe(1);
    // The parent has no row of their own: only the drop buzzes their phone.
    expect(providers.pushed).toContain('phone-busy-parent');
    // F 50, R 149 and the drop: R's surplus took the rest, not the drop's place.
    expect(pushedOf(BUSY)).toBe(BUSY_MEMBERS * PUSH_ROWS_PER_RECIPIENT);
    expect(pushedOf('fam-r')).toBe(PUSH_BATCH - BUSY_MEMBERS * PUSH_ROWS_PER_RECIPIENT - 1);
  });

  it('three families of nine members with ten rows each, the drop into the first: it goes out on the first tick', async () => {
    seed([{ id: BUSY, members: 9 }, { id: 'fam-g', members: 9 }, { id: 'fam-h', members: 9 }], BUSY);

    expect(await ticksUntilPushed(DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-busy-parent');
  });

  it('control: the same drop landing in a family with no rows of its own goes out on the first tick', async () => {
    seed([{ id: BUSY, members: BUSY_MEMBERS }, { id: 'fam-r', members: 30 }], QUIET);

    expect(await ticksUntilPushed(DROP, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-quiet');
  });
});

describe('read by read, at push\'s shares: the reviewer\'s reproductions', () => {
  type R = { id: string; family_id: string; user_id: string | null; related_type: string | null; related_id: string | null; seller_family_id?: string | null };
  /** What an exclusion leaves out, written out here rather than imported: a family at its share keeps the price drops that land in it. */
  const leftOut = (excluded: FairExclusion, r: R) => {
    if (!r.user_id && r.related_type === 'marketplace_listings') {
      return excluded.marketplace || excluded.landing.includes(r.family_id)
        || (r.related_id ? excluded.listings.includes(r.related_id) : excluded.unlisted);
    }
    if (excluded.families.includes(r.family_id)) return true;
    if (r.user_id) return excluded.recipients.includes(r.user_id);
    return excluded.familyWide.includes(r.family_id);
  };
  /** A forward-only range that answers each read as PostgREST does, at most db-max-rows (1,000) rows. */
  const range = (rows: R[]) => {
    const calls: { size: number; excluded: FairExclusion; ids: string[] }[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      const answer = rows.filter((r) => !leftOut(excluded, r)).slice(0, Math.min(size, 1000));
      calls.push({ size, excluded, ids: answer.map((r) => r.id) });
      return answer;
    };
    return { read, calls };
  };
  const own = (fam: string, members: number): R[] => Array.from({ length: members * PUSH_ROWS_PER_RECIPIENT }, (_, i) =>
    ({ id: `${fam}-${i}`, family_id: fam, user_id: `${fam}-u${Math.floor(i / PUSH_ROWS_PER_RECIPIENT)}`, related_type: null, related_id: null }));
  const drop = (landing: string): R =>
    ({ id: 'D', family_id: landing, user_id: null, related_type: 'marketplace_listings', related_id: 'honest', seller_family_id: 'honest' });
  const SHARES = { perFamily: PUSH_ROWS_PER_FAMILY, perRecipient: PUSH_ROWS_PER_RECIPIENT };
  const batchOf = async (rows: R[]) => {
    const { read, calls } = range(rows);
    const batch = await readFairBatch(read, PUSH_BATCH, SHARES);
    const by = (prefix: string) => batch.filter((r) => r.id.startsWith(`${prefix}-`)).length;
    return { ids: batch.map((r) => r.id), by, calls };
  };

  it('F 5 x 10 rows, R 30 x 10 rows, then the drop into F: the batch is F 50, R 149 and the drop, taken in the family pass', async () => {
    const { ids, by, calls } = await batchOf([...own('F', 5), ...own('R', 30), drop('F')]);
    expect(ids).toHaveLength(PUSH_BATCH);
    expect(ids).toContain('D');
    expect([by('F'), by('R')]).toEqual([50, 149]);
    // The read that reached it left F (and R) out: the family pass.
    expect(calls.some((c) => c.excluded.families.includes('F') && c.ids.includes('D'))).toBe(true);
  });

  it('three families of nine members with ten rows each, the drop into the first: it is in the batch', async () => {
    const { ids } = await batchOf([...own('F', 9), ...own('G', 9), ...own('H', 9), drop('F')]);
    expect(ids).toHaveLength(PUSH_BATCH);
    expect(ids).toContain('D');
  });

  it('control: the drop landing in a quiet family is in the batch, F 50 and R 149 beside it', async () => {
    const { ids, by } = await batchOf([...own('F', 5), ...own('R', 30), drop('Q')]);
    expect(ids).toContain('D');
    expect([by('F'), by('R')]).toEqual([50, 149]);
  });

  it('control: F\'s own whole-family row in the same place is F\'s, and still waits with F', async () => {
    const wide: R = { id: 'F-wide', family_id: 'F', user_id: null, related_type: null, related_id: null };
    const { ids } = await batchOf([...own('F', 5), ...own('R', 30), wide]);
    expect(ids).toHaveLength(PUSH_BATCH);
    expect(ids).not.toContain('F-wide');
  });

  it('isExcluded: a family at its share keeps the price drops that land in it, and only those', () => {
    const excluded: FairExclusion = { families: ['F'], recipients: [], familyWide: [], marketplace: false, listings: [], landing: [], unlisted: false };
    expect(isExcluded(excluded, drop('F'))).toBe(false);
    expect(isExcluded(excluded, { id: 'F-wide', family_id: 'F', user_id: null, related_type: null, related_id: null })).toBe(true);
    expect(isExcluded(excluded, { id: 'F-chat', family_id: 'F', user_id: null, related_type: 'calendar_events', related_id: 'e1' })).toBe(true);
    expect(isExcluded(excluded, own('F', 1)[0])).toBe(true);
    // A row addressed to a member about a listing is the member's, not the marketplace's.
    expect(isExcluded(excluded, { id: 'F-reserve', family_id: 'F', user_id: 'F-u0', related_type: 'marketplace_listings', related_id: 'honest' })).toBe(true);
  });
});
