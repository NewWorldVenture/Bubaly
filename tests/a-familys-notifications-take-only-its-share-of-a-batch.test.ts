// household-roles round 9 (R8-RV2): notification dispatch is shared by FAMILY.
//
// Round 8 shared each push and email batch by recipient, on the premise that a
// member can only plant rows addressed to themselves. Two holes were left:
//
// - A member can CAUSE whole-family rows (user_id null). 0191's
//   marketplace_log_price_change (SECURITY DEFINER, after update of
//   price_cents) writes one into every family that saved a listing, on every
//   price drop, and a listing's owner may PATCH its price up and down at will.
//   The recipient share never held a whole-family row, so a thousand price
//   drops filled every push batch and the neighbours' and the parent's due
//   pushes waited. Several members of one family flooding at once likewise
//   took that many recipient shares between them: the whole batch.
// - The push cursor's wrap (the only path that retries a row behind it) ran
//   only when the forward batch came back short, and the share's surplus fill
//   kept it full while one member held 200 rows ahead of the cursor. Every
//   other family's retries starved.
//
// Now a batch is shared by family first, by recipient inside a family (its
// whole-family rows counting as one recipient), and the retries behind the
// cursor keep their own part of every read (lib/notifications/fair-batch.ts).
// Dropping notif_insert and throttling the trigger are owner actions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { notificationId } from './helpers/push-dispatch-db';

const providers = vi.hoisted(() => ({
  pushed: [] as string[],
  failing: new Set<string>(),
  email: vi.fn(),
  users: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }) => {
      const device = subscription.endpoint.split('/').pop()!;
      providers.pushed.push(device);
      if (providers.failing.has(device)) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
      return { statusCode: 201 };
    },
  },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));
vi.mock('@/lib/email', () => ({ emailEnabled: () => true, sendReactEmail: providers.email }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: providers.users }));

const { dispatchPendingPushes } = await import('@/lib/server/push');
const { deliverNotificationEmails } = await import('@/lib/server/notification-emails');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const FAMILY = 'fam-rivera';
const NEIGHBOURS = 'fam-okafor';
const PARENT_ROW = notificationId(5001);
const NEIGHBOUR_ROW = notificationId(5002);
const at = (ms: number) => new Date(ms).toISOString();
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;

const notice = (id: string, familyId: string, userId: string | null, createdAt: string, title: string, relatedType: string | null = null): Row => ({
  id, family_id: familyId, user_id: userId, type: 'system', title, body: null, related_type: relatedType, related_id: null,
  is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
});
/** What 0191's trigger writes on each price drop of a listing the family saved: one whole-family row. */
const priceDrops = (count: number, familyId: string, createdAt: (n: number) => string, from = 1) =>
  Array.from({ length: count }, (_, i) => notice(notificationId(from + i), familyId, null, createdAt(i), 'Price dropped: "Bike"', 'marketplace_listings'));
/** What a member files directly against the API: rows addressed to themselves, dated as they like. */
const planted = (userId: string, count: number, createdAt: (n: number) => string, from: number) =>
  Array.from({ length: count }, (_, i) => notice(notificationId(from + i), FAMILY, userId, createdAt(i), 'Planted'));
const dueRows = () => [
  notice(PARENT_ROW, FAMILY, 'u-parent', at(NOW.getTime() - 60_000), 'Pick-up moved to 3pm'),
  notice(NEIGHBOUR_ROW, NEIGHBOURS, 'u-neighbour', at(NOW.getTime() - 30_000), 'Bin day tomorrow'),
];
const device = (id: string, userId: string): Row => ({
  id, user_id: userId, enabled: true, provider: 'webpush', platform: 'web', endpoint: `https://push.example.test/${id}`,
  p256dh: 'key', auth: 'auth', token: null, last_seen_at: '2026-10-01T00:00:00.000Z',
});
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;
/** Ten children in the Riveras' family, each with a kid login and a phone. */
const CHILDREN = Array.from({ length: 10 }, (_, i) => `u-child-${i}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.pushed = [];
  providers.failing = new Set();
  providers.email.mockReset().mockResolvedValue({ ok: true });
  providers.users.mockReset().mockResolvedValue({
    users: [
      { id: 'u-parent', email: 'parent@example.test', user_metadata: { display_name: 'Ada' } },
      { id: 'u-adult', email: 'adult@example.test', user_metadata: { display_name: 'Ben' } },
      // Kid logins' synthetic addresses: their rows are settled unsent.
      { id: 'u-child', email: 'child.sam@kids.bubaly.app', user_metadata: { display_name: 'Sam' } },
      ...CHILDREN.map((id, i) => ({ id, email: `child.kid${i}@kids.bubaly.app`, user_metadata: { display_name: `Kid ${i}` } })),
      { id: 'u-neighbour', email: 'neighbour@example.test', user_metadata: { display_name: 'Chi' } },
    ],
    error: null,
  });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', closed_at: null }, { id: NEIGHBOURS, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true },
    { id: 'm-adult', family_id: FAMILY, user_id: 'u-adult', role: 'adult', is_active: true },
    { id: 'm-child', family_id: FAMILY, user_id: 'u-child', role: 'child', is_active: true },
    ...CHILDREN.map((id, i) => ({ id: `m-child-${i}`, family_id: FAMILY, user_id: id, role: 'child', is_active: true })),
    { id: 'm-neighbour', family_id: NEIGHBOURS, user_id: 'u-neighbour', role: 'parent', is_active: true },
  ]);
  db.seed('push_devices', [
    device('phone-parent', 'u-parent'), device('phone-adult', 'u-adult'), device('phone-child', 'u-child'),
    ...CHILDREN.map((id, i) => device(`phone-child-${i}`, id)),
    device('phone-neighbour', 'u-neighbour'),
  ]);
  db.seed('user_preferences', []);
  db.seed('family_ai_settings', []);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('push: one family takes only its share of a batch', () => {
  it('1,000 whole-family price-drop rows a member caused do not hold back the neighbours\' or the parent\'s due push', async () => {
    db.seed('notifications', [...priceDrops(1000, FAMILY, (n) => at(NOW.getTime() - 120_000 + n)), ...dueRows()]);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toContain('phone-neighbour');
    expect(notifications).toBeLessThanOrEqual(200);
  });

  it('ten members of one family flooding together take that family\'s share, not the whole batch', async () => {
    db.seed('notifications', [
      ...CHILDREN.flatMap((id, c) => planted(id, 100, (n) => at(c * 1_000 + n), 1 + c * 100)),
      ...dueRows(),
    ]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
  });

  it('a parent\'s row in a family that four children and the price drops filled is still reached, once no other family is waiting', async () => {
    db.seed('notifications', [
      ...CHILDREN.slice(0, 4).flatMap((id, c) => planted(id, 100, (n) => at(c * 1_000 + n), 1 + c * 100)),
      ...priceDrops(1000, FAMILY, (n) => at(NOW.getTime() - 120_000 + n), 1001),
      ...dueRows(),
    ]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
  });

  it('control: a lone family\'s backlog of 300, members\' and whole-family rows alike, still goes out a full batch at a time', async () => {
    const owners = ['u-parent', 'u-adult', null] as const;
    db.seed('notifications', Array.from({ length: 300 }, (_, i) =>
      notice(notificationId(i + 1), FAMILY, owners[i % 3], at(NOW.getTime() - 3_600_000 + i), `Reminder ${i}`)));

    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(200);
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(200);
    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(100);
    expect(db.table('notifications').every((n) => n.pushed_at)).toBe(true);
  });

  it('control: a family\'s own whole-family notice beside its backlog still goes out on the first tick', async () => {
    db.seed('notifications', [
      ...Array.from({ length: 300 }, (_, i) => notice(notificationId(i + 1), FAMILY, 'u-parent', at(NOW.getTime() - 3_600_000 + i), `Reminder ${i}`)),
      notice(notificationId(900), FAMILY, null, at(NOW.getTime() - 10_000), 'Family dinner at 6'),
    ]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(notificationId(900)).pushed_at).toBeTruthy();
  });
});

describe('push: the retries behind the cursor keep their own part of every run', () => {
  /** Tick 1: the neighbours' push fails with a 503 and stays pending; the parent's goes out. */
  async function failedNeighbour() {
    providers.failing.add('phone-neighbour');
    db.seed('notifications', dueRows());
    await dispatchPendingPushes(asDb(), { now: NOW });
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeNull();
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
    providers.failing.delete('phone-neighbour');
    providers.pushed = [];
  }
  const later = new Date(NOW.getTime() + 60 * 60 * 1000);

  it('a row whose push failed is retried on the next tick despite 1,000 rows a child planted ahead of the cursor', async () => {
    await failedNeighbour();
    vi.setSystemTime(later);
    db.seed('notifications', planted('u-child', 1000, (n) => at(later.getTime() - 60_000 + n), 1));

    await dispatchPendingPushes(asDb(), { now: later });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toContain('phone-neighbour');
  });

  it('and despite a forward range full of other families\' fair rows', async () => {
    await failedNeighbour();
    vi.setSystemTime(later);
    // Twenty families with ten due rows each: every one within its share, 200 in all.
    const families = Array.from({ length: 20 }, (_, f) => `fam-${f}`);
    db.seed('families', families.map((id) => ({ id, timezone: 'UTC', closed_at: null })));
    db.seed('family_members', families.map((id, f) => ({ id: `m-${f}`, family_id: id, user_id: `u-${f}`, role: 'parent', is_active: true })));
    db.seed('notifications', families.flatMap((id, f) => Array.from({ length: 10 }, (_, i) =>
      notice(notificationId(10_000 + f * 10 + i), id, `u-${f}`, at(later.getTime() - 60_000 + f * 10 + i), `Notice ${i}`))));

    await dispatchPendingPushes(asDb(), { now: later });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
  });

  it('control: with nothing ahead of the cursor, the next tick wraps and retries it', async () => {
    await failedNeighbour();
    vi.setSystemTime(later);

    await dispatchPendingPushes(asDb(), { now: later });

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toEqual(['phone-neighbour']);
  });
});

describe('email: the digest follows the same family share', () => {
  it('ten kid logins in one family, 1,000 rows dated 1970 between them, do not keep the parent or the neighbours from their digest', async () => {
    db.seed('notifications', [
      ...CHILDREN.flatMap((id, c) => planted(id, 100, (n) => at(c * 1_000 + n), 1 + c * 100)),
      ...dueRows(),
    ]);

    const result = await deliverNotificationEmails(asDb());

    expect(providers.email.mock.calls.map(([input]) => input.to).sort()).toEqual(['neighbour@example.test', 'parent@example.test']);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(row(PARENT_ROW).sent_at).toBeTruthy();
    expect(row(NEIGHBOUR_ROW).sent_at).toBeTruthy();
    // One run still reads one bounded batch.
    expect(db.table('notifications').filter((n) => n.sent_at)).toHaveLength(500);
  });

  it('control: a lone family\'s backlog of 300 still goes out in one run, each member\'s in one digest', async () => {
    db.seed('notifications', Array.from({ length: 300 }, (_, i) =>
      notice(notificationId(i + 1), FAMILY, i % 2 ? 'u-adult' : 'u-parent', at(NOW.getTime() - 3_600_000 + i), `Reminder ${i}`)));

    expect(await deliverNotificationEmails(asDb())).toEqual({ sent: 2, failed: 0, skipped: 0 });
    const digests = Object.fromEntries(providers.email.mock.calls.map(([input]) => [input.to, input.react.props.items.length]));
    expect(digests).toEqual({ 'parent@example.test': 150, 'adult@example.test': 150 });
    expect(db.table('notifications').every((n) => n.sent_at)).toBe(true);
  });
});

describe('the shares, read by read', async () => {
  const { aheadAndBehind, readFairBatch } = await import('@/lib/notifications/fair-batch');
  type FairExclusion = import('@/lib/notifications/fair-batch').FairExclusion;
  type R = { id: string; family_id: string; user_id: string | null };
  /** What an exclusion leaves out, written out here rather than imported. */
  const leftOut = (excluded: FairExclusion, r: R) => excluded.families.includes(r.family_id)
    || (r.user_id ? excluded.recipients.includes(r.user_id) : excluded.familyWide.includes(r.family_id));
  const range = (rows: R[]) => {
    const calls: { size: number; excluded: FairExclusion }[] = [];
    const read = async (size: number, excluded: FairExclusion) => {
      calls.push({ size, excluded });
      return rows.filter((r) => !leftOut(excluded, r)).slice(0, size);
    };
    return { read, calls };
  };
  const rowsOf = (familyId: string, userId: string | null, count: number, prefix: string): R[] =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, family_id: familyId, user_id: userId }));
  const NONE: FairExclusion = { families: [], recipients: [], familyWide: [], marketplace: false, listings: [], unlisted: false };

  it('a family takes its share while another family waits, its whole-family rows counting as one recipient', async () => {
    const { read } = range([
      ...rowsOf('x', null, 30, 'w'), ...rowsOf('x', 'kid', 30, 'k'),
      { id: 'p0', family_id: 'x', user_id: 'parent' }, { id: 'y0', family_id: 'y', user_id: 'other' },
    ]);
    const batch = await readFairBatch(read, 12, { perFamily: 8, perRecipient: 3 });
    const ids = batch.map((r) => r.id);
    expect(batch).toHaveLength(12);
    // Before the surplus filled the room: 3 whole-family, 3 of the kid's, the parent's, the other family's.
    expect(ids.slice(0, 8).sort()).toEqual(['k0', 'k1', 'k2', 'p0', 'w0', 'w1', 'w2', 'y0'].sort());
  });

  it('lifts the family share before the recipient share, so a parent in a family floods filled comes before the floods\' surplus', async () => {
    const kids = ['a', 'b', 'c', 'd', 'e'];
    const { read } = range([
      ...kids.flatMap((kid) => rowsOf('x', kid, 20, kid)),
      { id: 'p0', family_id: 'x', user_id: 'parent' }, { id: 'y0', family_id: 'y', user_id: 'other' },
    ]);
    const batch = await readFairBatch(read, 40, { perFamily: 8, perRecipient: 2 });
    const ids = batch.map((r) => r.id);
    expect(ids).toContain('y0');
    expect(ids).toContain('p0');
    // Every flooding child got its share, and the parent its row, before any child's surplus.
    for (const kid of kids) expect(ids).toEqual(expect.arrayContaining([`${kid}0`, `${kid}1`]));
    // The first row of a child's surplus is there, and the parent's row was taken before it.
    expect(ids).toContain('a2');
    expect(ids.slice(0, ids.indexOf('a2'))).toContain('p0');
  });

  it('a batch nobody floods is one read', async () => {
    const { read, calls } = range([...rowsOf('x', 'kid', 3, 'k'), ...rowsOf('y', 'other', 3, 'o')]);
    expect(await readFairBatch(read, 200, { perFamily: 40, perRecipient: 10 })).toHaveLength(6);
    expect(calls).toHaveLength(1);
  });

  it('refuses a recipient share larger than the family\'s', async () => {
    await expect(readFairBatch(async () => [], 10, { perFamily: 2, perRecipient: 3 })).rejects.toThrow();
  });

  it('keeps the retries\' reserve of each read behind the cursor, gives what they leave to the rows ahead, and knows when ahead ran out', async () => {
    const aheadRows = rowsOf('x', 'kid', 300, 'a');
    const ahead = range(aheadRows);
    const behind = range([{ id: 'r0', family_id: 'y', user_id: 'other' }]);
    const ranges = aheadAndBehind(ahead.read, behind.read, 0.25);
    const first = await ranges.read(200, NONE);
    // 150 ahead, the reserve's 50 behind (one row there), then the 49 left go ahead too.
    expect(ahead.calls.map((c) => c.size)).toEqual([150, 199]);
    expect(behind.calls.map((c) => c.size)).toEqual([50]);
    expect(first[0].id).toBe('r0');
    expect(first).toHaveLength(200);
    expect(ranges.isBehind(first[0])).toBe(true);
    expect(ranges.isBehind(first[1])).toBe(false);
    expect(ranges.aheadExhausted(first)).toBe(false);
    // A short read is remembered: a later one leaving out at least as much is not asked again.
    await ranges.read(10, { families: [], recipients: ['other'], familyWide: [], marketplace: false, listings: [], unlisted: false });
    expect(behind.calls).toHaveLength(1);

    const small = range(aheadRows.slice(0, 2));
    const both = aheadAndBehind(small.read, behind.read, 0.25);
    const all = await both.read(200, NONE);
    expect(both.aheadExhausted(all)).toBe(true);
    expect(both.aheadExhausted(all.filter((r) => r.id !== 'a1'))).toBe(false);
  });
});
