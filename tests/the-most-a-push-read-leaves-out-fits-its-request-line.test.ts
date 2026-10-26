// household-roles round 13 (R12-RV1-EXCLUSION-SIZE-RESIDUAL-UNDERSTATED): the
// most a pending-push read can leave out still fits in its request line.
//
// A fair batch's read leaves out the families, recipients, listings and
// landing families that hold their share (lib/notifications/fair-batch.ts),
// and push sends every one of those ids in its read's URL, as PostgREST
// filters (lib/server/push.ts). Round 12 doubled the names kept for price
// drops whose listing is not found, so the most a read leaves out went from
// 40 listings and 40 landing families to 80 and 60. Each id costs 39 bytes of
// the request line (36 and an encoded comma), and past the gateway's
// request-line limit (nginx's `large_client_header_buffers 4 8k`, which the
// repo sizes every id list against: lib/supabase/chunked-in.ts) the read fails
// 'Pending-push read failed.' and no family gets a push, on every run while
// the flood lasts.
//
// So the request line is measured here, not estimated. The first case builds
// the read for the most the header says one read leaves out, through the real
// dispatchPendingPushes and supabase-js, over a fetch that captures the URL.
// The second drives a flood that fills every pool of names through the real
// dispatchPendingPushes on the in-memory database, pins each pool at its size
// (a later widening fails here, not at the gateway) and measures the request
// line of every read it made, by replaying the read's builder calls through
// supabase-js. Measured when written: 7,804 bytes at most in the global scan
// and 7,854 in a family-scoped one (both in a read behind the cursor), of which
// the names round 12 added are 2,340; the flood's longest read, 5,563. One
// more pool of twenty listing names in the bound comes to 8,457, and fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { FairExclusion, FairRead, FairRow, FairShares } from '@/lib/notifications/fair-batch';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { notificationId } from './helpers/push-dispatch-db';

// The real readFairBatch, each read it makes recorded; and, when a case asks,
// one read first that leaves out `inject`, so push's real page() builds it.
const probe = vi.hoisted(() => ({ inject: null as FairExclusion | null, exclusions: [] as FairExclusion[] }));
vi.mock('@/lib/notifications/fair-batch', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/notifications/fair-batch')>();
  return {
    ...real,
    readFairBatch: async <T extends FairRow>(read: FairRead<T>, size: number, shares: FairShares) => {
      const recorded: FairRead<T> = (wanted, excluded) => { probe.exclusions.push(excluded); return read(wanted, excluded); };
      if (probe.inject) await recorded(size, probe.inject);
      return real.readFairBatch(recorded, size, shares);
    },
  };
});
vi.mock('web-push', () => ({ default: { setVapidDetails: () => {}, sendNotification: async () => ({ statusCode: 201 }) } }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

const { dispatchPendingPushes, PUSH_ROWS_PER_FAMILY, PUSH_ROWS_PER_RECIPIENT } = await import('@/lib/server/push');

type DB = SupabaseClient<Database>;
/** nginx's default `large_client_header_buffers 4 8k`: the request line must fit 8 KB. */
const REQUEST_LINE_LIMIT = 8192;
/** dispatchPendingPushes' batch: its default and its largest limit. */
const BATCH = 200;
/** size / perRecipient: the full shares a batch holds, and the size of a pool of names. */
const NAMED = BATCH / PUSH_ROWS_PER_RECIPIENT;
/**
 * The header's bound on what one read leaves out, kind by kind, at push's
 * shares: the families holding their share; the recipients and the families'
 * whole-family rows holding theirs, between them; the listings (those at
 * their own share, and 1 + 2 pools of names); and the landing families (the
 * full sellers' own, and 1 + 1 pools of names). The flood below holds the
 * reads to it, and the first case measures it: raising it is the one way to
 * let a pool grow, and then it must still fit.
 */
const BOUND = { families: BATCH / PUSH_ROWS_PER_FAMILY, shareHolders: NAMED, listings: 4 * NAMED, landing: 3 * NAMED };
const NOW = new Date('2026-10-23T12:00:00.000Z');
/** A uuid, as every id a push read leaves out is (family, user and listing ids). */
const uuid = (kind: string, n: number) => `${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuids = (kind: string, count: number) => Array.from({ length: count }, (_, i) => uuid(kind, i + 1));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const requestLineOf = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  return { url, line: `${init?.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1` };
};
/** The real supabase-js client over a fetch that hands each request to `answer`. */
const client = (answer: (url: URL, line: string, method: string) => Response) => createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
  accessToken: async () => null,
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async (input, init) => {
      const { url, line } = requestLineOf(input, init);
      return answer(url, line, init?.method ?? 'GET');
    },
  },
});

beforeEach(() => {
  probe.inject = null;
  probe.exclusions = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the most the header says a push read leaves out, built by push and supabase-js', () => {
  // BOUND, every kind at once: 5 families; 20 share holders, recipients and
  // a family's whole-family rows, so both filters are in the URL; 80
  // listings and 60 landing families; and the marketplace and the unlisted
  // drops. It over-counts: the listings left out at their own share are
  // among the 20 share holders, and are counted again under the listings.
  // 165 ids.
  const ceiling: FairExclusion = {
    families: uuids('fa000000', BOUND.families),
    recipients: uuids('ab000000', BOUND.shareHolders - 1),
    familyWide: uuids('fb000000', 1),
    marketplace: true,
    listings: uuids('cd000000', BOUND.listings),
    landing: uuids('de000000', BOUND.landing),
    unlisted: true,
  };
  // The longest cursor push stores: microseconds and an offset, as PostgREST
  // returns a timestamptz, with the retries' own place behind it, so the
  // reads behind the cursor carry two keyset filters.
  const position = (n: number) => ({ createdAt: `2026-10-23T10:00:00.12345${n}+00:00`, id: notificationId(n) });
  const cursor = { version: 1, ...position(1), retry: position(2), generation: '7d3f6a52-1b4e-4c1a-9a57-2f0c1e9b8d41' };

  it.each([
    ['the global scan', {}],
    ['a family-scoped scan', { familyId: uuid('fe000000', 1) }],
  ] as const)('%s: every range\'s read of it fits in 8 KB', async (_scope, scope) => {
    const lines: string[] = [];
    const db = client((url, line, method) => {
      const table = url.pathname.split('/').at(-1);
      if (method === 'GET' && table === 'app_settings') return json([{ value: cursor }]);
      if (method === 'GET' && table === 'notifications') { lines.push(line); return json([]); }
      throw new Error(`Unexpected ${method} on ${table}`);
    });
    probe.inject = ceiling;

    const result = await dispatchPendingPushes(db as DB, { now: NOW, ...scope });

    expect(result.notifications).toBe(0);
    // The read push's page() built for it, in every range: ahead of the
    // cursor, behind it from the retries' place, and lapped from the oldest.
    const all = [...ceiling.families, ...ceiling.recipients, ...ceiling.familyWide, ...ceiling.listings, ...ceiling.landing];
    const built = lines.filter((line) => all.every((id) => line.includes(id)));
    expect(built).toHaveLength(3);
    expect(built.filter((line) => line.split('created_at.').length > 4)).toHaveLength(2);
    for (const line of built) {
      expect(line.length, `request line of ${line.length} bytes`).toBeLessThanOrEqual(REQUEST_LINE_LIMIT);
    }
    // Calibration: the 165 ids are 6,435 bytes of it, so the line is the
    // ids and the read's fixed part, not a truncated URL.
    expect(Math.min(...built.map((line) => line.length))).toBeGreaterThan(all.length * 39);
  });
});

describe('a flood that fills every pool of names, through dispatchPendingPushes', () => {
  let db: InMemorySupabase;
  const drop = (n: number, familyId: string, listing: string): Row => {
    const createdAt = new Date(NOW.getTime() - 7_200_000 + n).toISOString();
    return {
      id: notificationId(n), family_id: familyId, user_id: null, type: 'system', title: 'Price dropped', body: null,
      related_type: 'marketplace_listings', related_id: listing,
      is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
    };
  };

  beforeEach(() => {
    db = createInMemorySupabase({ maxRows: 1000 });
    db.seed('user_preferences', []);
    db.seed('family_ai_settings', []);
    db.seed('family_members', []);
    db.seed('push_devices', []);
  });

  it('each pool names as many as the header says and no more, and the longest read it made fits in 8 KB', async () => {
    const rows: Row[] = [];
    const families = new Set<string>();
    const listings: Row[] = [];
    let n = 0;
    const add = (familyId: string, listing: string, times = 1) => {
      families.add(familyId);
      for (let k = 0; k < times; k += 1) rows.push(drop(++n, familyId, listing));
    };
    const live = (id: string, familyId: string) => { listings.push({ id, family_id: familyId, title: 'Bike', price_cents: 5000, status: 'available' }); return id; };
    const notFound = (i: number) => uuid('f0000000', i);
    const watcher = (i: number) => uuid('ee000000', i);
    const seller = (i: number) => uuid('5e000000', i);
    // Four families' deleted listings, saved in their own family: eleven drops
    // each, so the drops not found hold a family's share (40) and each listing
    // its own (10, then left out at its share).
    for (let f = 1; f <= 4; f += 1) add(notFound(f), uuid('d0000000', f), 11);
    // Two of them saved 30 more deleted listings each: twenty listing names
    // each, then the family itself; then 40 families that each saved one
    // deleted listing, named by family once the 40 listing names are spent.
    for (let f = 1; f <= 2; f += 1) for (let i = 1; i <= 30; i += 1) add(notFound(f), uuid('d1000000', f * 100 + i));
    for (let x = 1; x <= 40; x += 1) add(notFound(100 + x), uuid('d2000000', x));
    // A seller with a listing in their own family that fills their share and
    // its own, and a drop of another into their own family; and sixty more
    // listings, each saved by a different family.
    const sellerWith = (s: number, watched: number) => {
      add(seller(s), live(uuid('1a000000', s), seller(s)), 11);
      add(seller(s), live(uuid('1b000000', s), seller(s)));
      for (let w = 1; w <= watched; w += 1) add(watcher(s * 100 + w), live(uuid('1c000000', s * 100 + w), seller(s)));
    };
    sellerWith(1, 60);
    // Then more sellers alike, with no watchers, till the batch is full.
    for (let s = 2; s <= 20; s += 1) sellerWith(s, 0);
    db.seed('families', [...families].map((id) => ({ id, timezone: 'UTC', closed_at: null })));
    db.seed('marketplace_listings', listings);
    db.seed('notifications', rows);
    const reads: FaultCall[][] = [];
    const measured = withFaults(db, (table, calls) => {
      if (table === 'notifications' && calls[0]?.method === 'select') reads.push(calls);
      return null;
    });

    await dispatchPendingPushes(measured as unknown as DB, { now: NOW });

    const most = (pick: (excluded: FairExclusion) => number) => Math.max(...probe.exclusions.map(pick));
    const named = (ids: readonly string[], kind: string) => ids.filter((id) => id.startsWith(kind)).length;
    // Every pool of names, filled to its size and no further.
    expect(most((e) => named(e.listings, '1c000000')), 'the known sellers\' listing names').toBe(NAMED);
    expect(most((e) => named(e.landing, 'ee000000')), 'the known sellers\' landing names').toBe(NAMED);
    expect(most((e) => named(e.listings, 'd1000000') + named(e.listings, 'd2000000')), 'the listing names of the drops not found').toBe(2 * NAMED);
    expect(most((e) => named(e.landing, 'f0000000')), 'the landing names of the drops not found').toBe(NAMED);
    // So one read leaves out no more than the header's bound.
    expect(most((e) => e.listings.length)).toBeLessThanOrEqual(BOUND.listings);
    expect(most((e) => e.landing.length)).toBeLessThanOrEqual(BOUND.landing);
    expect(most((e) => e.families.length)).toBeLessThanOrEqual(BOUND.families);
    expect(most((e) => e.recipients.length + e.familyWide.length)).toBeLessThanOrEqual(BOUND.shareHolders);

    // Each read push made, as supabase-js puts it on the wire.
    const lines: string[] = [];
    const wire = client((url, line) => { lines.push(line); return json([]); });
    for (const calls of reads) {
      let query = wire.from('notifications') as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const { method, args } of calls) query = query[method](...args) as typeof query;
      await (query as unknown as PromiseLike<unknown>);
    }
    expect(lines).toHaveLength(reads.length);
    const longest = Math.max(...lines.map((line) => line.length));
    // Non-vacuity: the longest read carried the largest exclusion's ids.
    const largest = probe.exclusions.reduce((a, b) => (b.listings.length + b.landing.length > a.listings.length + a.landing.length ? b : a));
    expect(lines.some((line) => line.length === longest && [...largest.listings, ...largest.landing].every((id) => line.includes(id)))).toBe(true);
    expect(longest).toBeLessThanOrEqual(REQUEST_LINE_LIMIT);
  });
});
