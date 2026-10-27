// household-roles round 15 (R14-RV2-REACH-READ-ASSUMES-DB-MAX-ROWS): a read
// that reaches past a full seller's held-back drops, cut at the server's
// db-max-rows, is not taken for the end of its range.
//
// Round 14 holds a full seller's price drops back once the names a read can
// leave them out by are spent, and reads past them: a reach read asks for
// FAIR_READ_MAX_ROWS (1,000) rows, and once a read that far is still filled
// by rows taken or held, the marketplace is left out of the rest of the pass,
// so every family's own rows behind the flood are still reached
// (lib/notifications/fair-batch.ts, the seller paragraph). But PostgREST
// answers at most db-max-rows rows whatever a read asks for, and
// lib/supabase/read-all.ts allows for a project whose db-max-rows is 500.
// There the reach read came back with 500 rows, which looked short: the pass
// took that for the end of its range and ended, the recipient pass had the
// same exclusions and was skipped, and the surplus filled the batch from the
// flood. A neighbour's 'Bin day' behind one seller's 2,000 drops waited about
// ten ticks. On push's later runs aheadAndBehind also remembered the cut
// answer as short and answered the marketplace-out read from it, without the
// rows past the cut.
//
// Now a reach read that comes back short while it holds drops back is taken
// for out of reach, not for the end of the range, and aheadAndBehind does not
// remember a reach read's short answer. Driven through the real
// dispatchPendingPushes on the in-memory database at db-max-rows 500, with
// the web-push mock live, on the first run and on a run with a cursor; then
// read by read through readFairBatch and aheadAndBehind over ranges cut at
// 500 rows. Owner check: the production project's API Max Rows is at least
// 1,000 (a cap below a batch would cut the ordinary reads too).
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
const { aheadAndBehind, FAIR_READ_MAX_ROWS, readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
/** dispatchPendingPushes' batch. */
const PUSH_BATCH = 200;
/** A db-max-rows below FAIR_READ_MAX_ROWS, as lib/supabase/read-all.ts allows for. */
const CUT = 500;
/** One seller's drops, one per listing, each listing saved by a different family: more than any read reaches past. */
const FLOOD = 2000;
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

/** One dispatch a tick from `from` until `id` is pushed; how many ticks that took (at most `max`). */
async function ticksUntilPushed(id: string, max: number, from = NOW.getTime()): Promise<number> {
  let ticks = 0;
  for (let t = from; !row(id).pushed_at && ticks < max; t += TICK_MS) {
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
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('push: a neighbour\'s row behind one seller\'s flood, on a project whose db-max-rows is below 1,000', () => {
  const SELLER = 'fam-seller';
  const NEIGHBOUR = 'fam-neighbour';
  const BIN_DAY = notificationId(900_001);
  const WELCOME = notificationId(900_002);
  const watcher = (i: number) => `fam-watcher-${i}`;

  /** The families, the neighbour's phone and the seller's listings, each saved by a different family; no notifications yet. */
  function household(maxRows: number) {
    db = createInMemorySupabase({ maxRows });
    db.seed('user_preferences', []);
    db.seed('family_ai_settings', []);
    const watchers = Array.from({ length: FLOOD }, (_, i) => watcher(i));
    db.seed('families', [SELLER, NEIGHBOUR, ...watchers].map(family));
    db.seed('family_members', [member(SELLER, 'u-seller', 'child'), member(NEIGHBOUR, 'u-neighbour')]);
    db.seed('push_devices', [device('phone-neighbour', 'u-neighbour')]);
    db.seed('marketplace_listings', watchers.map((_, i) => listing(listingId(i + 1), SELLER)));
  }
  /** The seller's FLOOD drops, one a millisecond from `start`, then the neighbour's 'Bin day'. */
  const floodThenBinDay = (start: number): Row[] => [
    ...Array.from({ length: FLOOD }, (_, j) => notice(notificationId(j + 1), watcher(j), null, at(start + j), 'Price dropped: "Bike"', listingId(j + 1))),
    notice(BIN_DAY, NEIGHBOUR, 'u-neighbour', at(start + FLOOD), 'Bin day'),
  ];

  it.each([FAIR_READ_MAX_ROWS, CUT])('at db-max-rows %i, the first run: \'Bin day\' goes out on the first tick, in a full batch', async (maxRows) => {
    household(maxRows);
    db.seed('notifications', floodThenBinDay(NOW.getTime() - 3_600_000));

    expect(await ticksUntilPushed(BIN_DAY, 30)).toBe(1);
    expect(providers.pushed).toContain('phone-neighbour');
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(PUSH_BATCH);
  });

  it.each([FAIR_READ_MAX_ROWS, CUT])('at db-max-rows %i, a run with a cursor: the flood arrives after the last run, and \'Bin day\' goes out on the next tick', async (maxRows) => {
    household(maxRows);
    db.seed('notifications', [notice(WELCOME, NEIGHBOUR, 'u-neighbour', at(NOW.getTime() - 3_600_000), 'Welcome')]);
    expect(await ticksUntilPushed(WELCOME, 1)).toBe(1);
    // The first run stored a cursor, so the next reads split between the rows
    // ahead of it and those behind (aheadAndBehind).
    expect(db.table('app_settings').some((s) => s.key === 'push_dispatch_cursor:v1:global')).toBe(true);
    db.table('notifications').push(...floodThenBinDay(NOW.getTime() + 60_000));

    expect(await ticksUntilPushed(BIN_DAY, 30, NOW.getTime() + TICK_MS)).toBe(1);
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(1 + PUSH_BATCH);
  });
});

describe('read by read: a range cut at 500 rows, behind held-back drops', () => {
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
  /** A range that answers each read as PostgREST does, at most `cap` rows whatever it is asked for. */
  const range = (rows: R[], cap: number) => {
    const calls: { size: number; returned: number }[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      const answer = rows.filter((r) => !leftOut(excluded, r)).slice(0, Math.min(size, cap));
      calls.push({ size, returned: answer.length });
      return answer;
    };
    return { read, calls };
  };
  const drops = (prefix: string, count: number): R[] => Array.from({ length: count }, (_, i) =>
    ({ id: `${prefix}-${i}`, family_id: `w${prefix}-${i}`, user_id: null, related_type: 'marketplace_listings', related_id: `${prefix}${i}`, seller_family_id: 's' }));
  const BIN: R = { id: 'bin-day', family_id: 'neighbour', user_id: 'u-neighbour', related_type: null, related_id: null };
  const SHARES = {
    push: { size: PUSH_BATCH, perFamily: PUSH_ROWS_PER_FAMILY, perRecipient: PUSH_ROWS_PER_RECIPIENT },
    // deliverNotificationEmails reads no whole-family row, so no price drop
    // reaches it; this is the selector it shares, at its shares.
    email: { size: 500, perFamily: EMAIL_ROWS_PER_FAMILY, perRecipient: EMAIL_ROWS_PER_RECIPIENT },
  } as const;

  it.each(Object.entries(SHARES))('%s\'s shares: the ordinary row behind 2,000 drops is in the batch, which is full', async (_name, { size, perFamily, perRecipient }) => {
    const { read, calls } = range([...drops('A', FLOOD), BIN], CUT);
    const batch = await readFairBatch(read, size, { perFamily, perRecipient });
    expect(batch.map((r) => r.id)).toContain('bin-day');
    expect(batch).toHaveLength(size);
    // Non-vacuity: a read asked past the cut and was answered at it.
    expect(calls.some((c) => c.size === FAIR_READ_MAX_ROWS && c.returned === CUT)).toBe(true);
  });

  it('push\'s later runs: over a cursor\'s two ranges, both cut at 500 rows, the ordinary row ahead is in the batch', async () => {
    const ahead = range([...drops('A', FLOOD), BIN], CUT);
    const behind = range(drops('B', 300), CUT);
    const ranges = aheadAndBehind(ahead.read, behind.read, PUSH_RETRY_SHARE);
    const batch = await readFairBatch(ranges.read, PUSH_BATCH, SHARES.push);
    expect(batch.map((r) => r.id)).toContain('bin-day');
    expect(batch).toHaveLength(PUSH_BATCH);
    // Non-vacuity: the read ahead asked past the cut and was answered at it.
    expect(ahead.calls.some((c) => c.size > CUT && c.returned === CUT)).toBe(true);
  });

  it('control: a range that really ends inside a reach read, held-back drops in it, still fills the batch from the surplus', async () => {
    const { read } = range(drops('A', 600), CUT);
    const batch = await readFairBatch(read, PUSH_BATCH, SHARES.push);
    expect(batch).toHaveLength(PUSH_BATCH);
  });
});
