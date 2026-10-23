// R8-RV1 — a member's planted notifications held back every family's pushes
// and digests.
//
// 0388's notif_insert still lets a member's session insert any number of
// notifications addressed to themselves, with any created_at, send_at,
// pushed_at or sent_at. Push takes 200 rows a tick in created_at order and
// email the oldest 500 a day, so a child's thousand rows dated 1970 (or dated
// just ahead of everyone else's) filled every batch: no family's pushes went
// out until the flood drained at 200 a tick, and no family was emailed until a
// kid login's rows were settled unsent 500 a day. A row dated in the future
// never aged out of the push retry window, so one whose delivery failed was
// retried for good.
//
// Now a batch is shared by recipient (lib/notifications/fair-batch.ts), which
// is exactly who planted the rows, and a row dated after now is not read.
// Dropping the policy itself is an owner action (no application path inserts
// a notification on a member's session).
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

const { dispatchPendingPushes, PUSH_ROWS_PER_RECIPIENT, PUSH_RETRY_WINDOW_MS } = await import('@/lib/server/push');
const { deliverNotificationEmails, EMAIL_ROWS_PER_RECIPIENT } = await import('@/lib/server/notification-emails');
const { readFairBatch } = await import('@/lib/notifications/fair-batch');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const FAMILY = 'fam-rivera';
const NEIGHBOURS = 'fam-okafor';
const PARENT_ROW = notificationId(5001);
const NEIGHBOUR_ROW = notificationId(5002);
const at = (ms: number) => new Date(ms).toISOString();
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;

const notice = (id: string, familyId: string, userId: string | null, createdAt: string, title: string): Row => ({
  id, family_id: familyId, user_id: userId, type: 'system', title, body: null, related_type: null, related_id: null,
  is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
});
/** What the child files directly against the API: rows addressed to themselves, dated as they like. */
const planted = (count: number, createdAt: (n: number) => string, from = 1) =>
  Array.from({ length: count }, (_, i) => notice(notificationId(from + i), FAMILY, 'u-child', createdAt(i), 'Planted'));
const dueRows = () => [
  notice(PARENT_ROW, FAMILY, 'u-parent', at(NOW.getTime() - 60_000), 'Pick-up moved to 3pm'),
  notice(NEIGHBOUR_ROW, NEIGHBOURS, 'u-neighbour', at(NOW.getTime() - 30_000), 'Bin day tomorrow'),
];
const device = (id: string, userId: string): Row => ({
  id, user_id: userId, enabled: true, provider: 'webpush', platform: 'web', endpoint: `https://push.example.test/${id}`,
  p256dh: 'key', auth: 'auth', token: null, last_seen_at: '2026-10-01T00:00:00.000Z',
});
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.pushed = [];
  providers.failing = new Set();
  providers.email.mockReset().mockResolvedValue({ ok: true });
  providers.users.mockReset().mockResolvedValue({
    users: [
      { id: 'u-parent', email: 'parent@example.test', user_metadata: { display_name: 'Ada' } },
      // A kid login's synthetic address: its rows are settled unsent.
      { id: 'u-child', email: 'child.sam@kids.bubaly.app', user_metadata: { display_name: 'Sam' } },
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
    { id: 'm-child', family_id: FAMILY, user_id: 'u-child', role: 'child', is_active: true },
    { id: 'm-neighbour', family_id: NEIGHBOURS, user_id: 'u-neighbour', role: 'parent', is_active: true },
  ]);
  db.seed('push_devices', [device('phone-parent', 'u-parent'), device('phone-child', 'u-child'), device('phone-neighbour', 'u-neighbour')]);
  db.seed('user_preferences', []);
  db.seed('family_ai_settings', []);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a member\'s own notifications cannot hold back anyone else\'s push', () => {
  it.each([
    ['dated 1970, ahead of every row', (n: number) => at(n)],
    ['dated just ahead of the parent\'s row', (n: number) => at(NOW.getTime() - 120_000 + n)],
  ])('a child\'s 1,000 rows %s: the parent\'s and the neighbours\' due pushes go out on the first tick', async (_label, createdAt) => {
    db.seed('notifications', [...planted(1000, createdAt), ...dueRows()]);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(providers.pushed).toContain('phone-parent');
    expect(providers.pushed).toContain('phone-neighbour');
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    // Still one bounded batch; the flood takes what room nobody else needed.
    expect(notifications).toBeLessThanOrEqual(200);
  });

  it('a family-wide notice is never left out with the flood (no member can plant one)', async () => {
    db.seed('notifications', [...planted(1000, at), notice(notificationId(5003), FAMILY, null, at(NOW.getTime() - 10_000), 'Family dinner at 6')]);

    await dispatchPendingPushes(asDb(), { now: NOW });

    expect(row(notificationId(5003)).pushed_at).toBeTruthy();
    expect(providers.pushed.filter((d) => d === 'phone-parent')).toHaveLength(1);
  });

  it('rows dated in the future are not read, so one that fails is not retried for good', async () => {
    providers.failing.add('phone-child');
    db.seed('notifications', [
      ...planted(1000, (n) => at(Date.parse('2100-01-01T00:00:00.000Z') + n)).map((n) => ({ ...n, send_at: '2026-10-01T00:00:00.000Z' })),
      ...dueRows(),
    ]);

    expect((await dispatchPendingPushes(asDb(), { now: NOW })).notifications).toBe(2);
    // A day later, past the retry window, they are still not being sent to anyone.
    vi.setSystemTime(new Date(NOW.getTime() + PUSH_RETRY_WINDOW_MS + 60_000));
    await dispatchPendingPushes(asDb(), { now: new Date(NOW.getTime() + PUSH_RETRY_WINDOW_MS + 60_000) });

    expect(providers.pushed).not.toContain('phone-child');
    expect(providers.pushed.filter((d) => d === 'phone-parent')).toHaveLength(1);
    expect(row(PARENT_ROW).pushed_at).toBeTruthy();
  });

  it('a future-dated row that is read anyway is given up on when it fails, not kept for ever', async () => {
    // The backstop under the read's bound: a database answering without it.
    const from = db.from.bind(db);
    const unbounded = {
      ...db,
      from: (table: string) => {
        const builder = from(table) as unknown as { lte: (column: string, value: unknown) => unknown };
        const lte = builder.lte.bind(builder);
        builder.lte = (column, value) => (column === 'created_at' ? builder : lte(column, value));
        return builder;
      },
    } as unknown as DB;
    providers.failing.add('phone-child');
    const future = notificationId(7001);
    db.seed('notifications', [notice(future, FAMILY, 'u-child', '2100-01-01T00:00:00.000Z', 'Planted')]);
    db.table('notifications')[0].send_at = '2026-10-01T00:00:00.000Z';

    await dispatchPendingPushes(unbounded, { now: NOW });

    expect(providers.pushed).toEqual(['phone-child']);
    expect(row(future).pushed_at).toBeTruthy();
  });

  it('control: a recipient\'s own backlog with nobody else waiting still fills the batch', async () => {
    db.seed('notifications', Array.from({ length: 300 }, (_, i) =>
      notice(notificationId(i + 1), FAMILY, 'u-parent', at(NOW.getTime() - 3_600_000 + i), `Reminder ${i}`)));

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(notifications).toBe(200);
    expect(db.table('notifications').filter((n) => n.pushed_at)).toHaveLength(200);
    // In created_at order: the oldest 200, and the cursor at the last of them.
    expect(db.table('notifications').slice(0, 200).every((n) => n.pushed_at)).toBe(true);
    expect((db.table('app_settings')[0].value as { id: string }).id).toBe(notificationId(200));
  });
});

describe('a member\'s own notifications cannot hold back anyone else\'s digest', () => {
  it('a kid login\'s 1,000 rows dated 1970: the parent and the neighbours are emailed on the first run', async () => {
    db.seed('notifications', [...planted(1000, at), ...dueRows()]);

    const result = await deliverNotificationEmails(asDb());

    expect(providers.email.mock.calls.map(([input]) => input.to).sort()).toEqual(['neighbour@example.test', 'parent@example.test']);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
    expect(row(PARENT_ROW).sent_at).toBeTruthy();
    expect(row(NEIGHBOUR_ROW).sent_at).toBeTruthy();
    // One run still reads one bounded batch.
    expect(db.table('notifications').filter((n) => n.sent_at)).toHaveLength(500);
  });

  it('rows dated after now are not read at all', async () => {
    db.seed('notifications', [...planted(10, (n) => at(Date.parse('2100-01-01T00:00:00.000Z') + n)).map((n) => ({ ...n, send_at: '2026-10-01T00:00:00.000Z' })), ...dueRows()]);

    expect(await deliverNotificationEmails(asDb())).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(db.table('notifications').filter((n) => n.user_id === 'u-child').every((n) => n.sent_at === null)).toBe(true);
  });

  it('control: a recipient\'s own large backlog is still one digest, beside someone else\'s', async () => {
    db.seed('notifications', [
      ...Array.from({ length: 120 }, (_, i) => notice(notificationId(i + 1), FAMILY, 'u-parent', at(NOW.getTime() - 3_600_000 + i), `Reminder ${i}`)),
      dueRows()[1],
    ]);

    expect(await deliverNotificationEmails(asDb())).toEqual({ sent: 2, failed: 0, skipped: 0 });
    const parentDigest = providers.email.mock.calls.find(([input]) => input.to === 'parent@example.test')![0];
    expect(parentDigest.react.props.items).toHaveLength(120);
    expect(parentDigest.react.props.items[0].title).toBe('Reminder 0');
    expect(db.table('notifications').every((n) => n.sent_at)).toBe(true);
  });
});

describe('readFairBatch', () => {
  it('each dispatcher\'s share is smaller than the backlogs the controls above use', () => {
    // Non-vacuity for the controls: a share at or above them would pass them unexercised.
    expect(PUSH_ROWS_PER_RECIPIENT).toBeGreaterThan(0);
    expect(PUSH_ROWS_PER_RECIPIENT).toBeLessThan(200);
    expect(EMAIL_ROWS_PER_RECIPIENT).toBeGreaterThan(0);
    expect(EMAIL_ROWS_PER_RECIPIENT).toBeLessThan(120);
  });

  type R = { id: string; user_id: string | null };
  /** A range of rows read the way PostgREST would: in order, leaving out excluded recipients. */
  const range = (rows: R[]) => {
    const calls: { size: number; excluded: string[] }[] = [];
    const read = async (size: number, excluded: readonly string[]) => {
      calls.push({ size, excluded: [...excluded] });
      return rows.filter((r) => !r.user_id || !excluded.includes(r.user_id)).slice(0, size);
    };
    return { read, calls };
  };

  it('gives everyone else the room ahead of a recipient\'s surplus, then fills what is left', async () => {
    const rows: R[] = [
      ...Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, user_id: 'flood' })),
      { id: 'b0', user_id: 'other' }, { id: 'f0', user_id: null },
    ];
    const { read } = range(rows);
    const batch = await readFairBatch(read, 10, 3);
    expect(batch.map((r) => r.id).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b0', 'f0'].sort());
  });

  it('ends after a bounded number of reads however many recipients flood, with a short exclusion list', async () => {
    // Forty recipients, each one row over their share, one after another.
    const rows: R[] = Array.from({ length: 21 * 40 }, (_, i) => ({ id: `r${i}`, user_id: `u${Math.floor(i / 21)}` }));
    const { read, calls } = range(rows);
    const batch = await readFairBatch(read, 200, 20);
    expect(batch).toHaveLength(200);
    expect(new Set(batch.map((r) => r.id)).size).toBe(200);
    const held = new Map<string, number>();
    for (const r of batch) held.set(r.user_id!, (held.get(r.user_id!) ?? 0) + 1);
    expect(Math.max(...held.values())).toBeLessThanOrEqual(20);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(200 / 20 + 1);
    expect(Math.max(...calls.map((c) => c.excluded.length))).toBeLessThan(200 / 20);
  });

  it('ends when a read ignores the exclusion it was given', async () => {
    const rows: R[] = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, user_id: 'only' }));
    const batch = await readFairBatch(async (size) => rows.slice(0, size), 500, 50);
    expect(batch).toHaveLength(300);
  });

  it('refuses a recipient id that would be filter syntax', async () => {
    const { recipientList } = await import('@/lib/notifications/fair-batch');
    expect(recipientList(['00000000-0000-4000-8000-000000000001', 'u-child'])).toBe('(00000000-0000-4000-8000-000000000001,u-child)');
    expect(() => recipientList(['a),id.gt.(0'])).toThrow();
  });
});
