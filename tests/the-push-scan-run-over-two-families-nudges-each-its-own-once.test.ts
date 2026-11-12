// GET /api/cron/push-scan (API-0FE523360549, JOB-90FBAEB0B37F), driven through
// the real exported handler, the real cron-secret check, the real generator,
// the real chore-respawn sweep and the real push dispatch, over the in-memory
// database. Only the push provider is stubbed, at the seam
// push-delivery-retry.test.ts stubs it (`web-push`, plus the endpoint's DNS check).
//
// What the existing tests already prove, and so is not repeated here:
// - a-closed-family-is-left-alone-by-the-crons: the route generates nothing for
//   a closed family (generator mocked); dispatch skips its queued rows.
// - push-delivery-retry: provider failure / missing config / cursor failure
//   answers 502 and is retried (fixture db, generation and respawn mocked);
//   401 without the secret touches no provider.
// - one-generator-per-family-at-a-time: concurrent ticks on ONE family file once.
// - the-notification-generator-says-what-it-could-not-check: a failed source
//   read in ONE family answers 502.
// - a-daily-chore-is-back-tomorrow: respawnMissingChoreAssignments itself, and
//   a source pin that the route calls it.
// - push-scan-rotates-by-its-slot, a-slow-generation-pass-cannot-starve-delivery,
//   whole-table-reads-are-not-capped: rotation, budgets, paging.
// New here: one populated run over two open households and a closed one, with a
// removed member, a push opt-out and a family that turned its children's push
// off — the notices written, the chores respawned and the devices buzzed, per
// family; that the push scan sends no email; a second run; a refused read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
const provider = vi.hoisted(() => ({ push: vi.fn(), email: vi.fn(), serviceClient: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: provider.serviceClient,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.push } }));
// The endpoint's DNS re-check (asserted in push-endpoint-ssrf-guard.test.ts); fixture hosts do not resolve.
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));
// Stubbed only so the file can say the push scan sends no email.
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  emailEnabled: () => true,
  sendReactEmail: provider.email,
}));

const { GET } = await import('@/app/api/cron/push-scan/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-09-30T12:00:00.000Z';
const A = 'fam-a';
const B = 'fam-b';
const CLOSED = 'fam-c';
const FAMILIES = [A, B, CLOSED] as const;
type Family = typeof FAMILIES[number];

type Person = { member: string; user: string; family: Family; role: string; active: boolean };
const PEOPLE: Person[] = [
  // A: an adult has left the family.
  { member: 'm-a-parent', user: 'u-a-parent', family: A, role: 'parent', active: true },
  { member: 'm-a-kid', user: 'u-a-kid', family: A, role: 'child', active: true },
  { member: 'm-a-gone', user: 'u-a-gone', family: A, role: 'guest', active: false },
  // B: the parent turned push off; the family turned its children's push off.
  { member: 'm-b-parent', user: 'u-b-parent', family: B, role: 'parent', active: true },
  { member: 'm-b-adult', user: 'u-b-adult', family: B, role: 'adult', active: true },
  { member: 'm-b-kid', user: 'u-b-kid', family: B, role: 'child', active: true },
  { member: 'm-c-parent', user: 'u-c-parent', family: CLOSED, role: 'parent', active: true },
  { member: 'm-c-kid', user: 'u-c-kid', family: CLOSED, role: 'child', active: true },
];
const TAG: Record<Family, string> = { [A]: '(A)', [B]: '(B)', [CLOSED]: '(C)' };
const kidOf = (family: Family) => PEOPLE.find((p) => p.family === family && p.role === 'child')!;
const STALE_ID = '00000000-0000-4000-8000-0000000000a1';
const HANDLED_ID = '00000000-0000-4000-8000-0000000000b1';

let db: InMemorySupabase;

function households() {
  db = createInMemorySupabase({
    defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } },
    uniques: { app_settings: [['key']], chore_assignments: [['family_id', 'idempotency_key']] },
  });
  h.db = db;
  db.seed('families', [
    { id: A, timezone: 'UTC', closed_at: null },
    { id: B, timezone: 'UTC', closed_at: null },
    { id: CLOSED, timezone: 'UTC', closed_at: '2026-09-01T00:00:00.000Z' },
  ]);
  db.seed('family_members', PEOPLE.map((p) => ({
    id: p.member, family_id: p.family, user_id: p.user, role: p.role, is_active: p.active, display_name: p.member, birthday: null,
  })));
  db.seed('push_devices', PEOPLE.map((p) => ({
    id: `d-${p.user}`, user_id: p.user, enabled: true, provider: 'webpush', endpoint: `https://push.example.com/${p.user}`, p256dh: 'k', auth: 'a',
  })));
  db.seed('user_preferences', [{ user_id: 'u-b-parent', email_enabled: true, push_enabled: false }]);
  db.seed('family_ai_settings', [{ family_id: B, child_channels: { push: false } }]);
  for (const family of FAMILIES) {
    const kid = kidOf(family);
    db.seed('chores', [
      // Due in three hours: one chore_due notice for the kid.
      { id: `ch-${family}`, family_id: family, title: `Feed the cat ${TAG[family]}`, recurrence: 'none', is_active: true },
      // Weekly, approved last Monday, with no successor: the respawn sweep's work.
      { id: `wk-${family}`, family_id: family, title: `Water the plants ${TAG[family]}`, recurrence: 'weekly', points: 5, difficulty: 'easy', reward_mode: 'fixed_points', proof_required: 'none', requires_approval: true, is_active: true },
    ]);
    db.seed('chore_assignments', [
      { id: `ca-${family}`, family_id: family, chore_id: `ch-${family}`, member_id: kid.member, status: 'todo', due_at: '2026-09-30T15:00:00.000Z', idempotency_key: `seed-ca-${family}` },
      {
        id: `wa-${family}`, family_id: family, chore_id: `wk-${family}`, member_id: kid.member, status: 'approved', due_at: '2026-09-28T09:00:00.000Z',
        approved_at: '2026-09-28T10:00:00.000Z', submitted_at: '2026-09-28T09:30:00.000Z', idempotency_key: `seed-wa-${family}`,
      },
    ]);
  }
  // The weekly chore of the adult who left family A, approved before they left.
  db.seed('chore_assignments', [{
    id: 'wa-a-gone', family_id: A, chore_id: `wk-${A}`, member_id: 'm-a-gone', status: 'approved', due_at: '2026-09-28T09:00:00.000Z',
    approved_at: '2026-09-28T10:00:00.000Z', submitted_at: '2026-09-28T09:30:00.000Z', idempotency_key: 'seed-wa-a-gone',
  }]);
  db.seed('notifications', [
    { id: STALE_ID, family_id: A, user_id: 'u-a-gone', type: 'system', title: 'Old notice (A)', body: null, related_type: null, related_id: null, send_at: '2026-09-30T11:00:00.000Z', created_at: '2026-09-30T11:00:00.000Z' },
    {
      id: HANDLED_ID, family_id: B, user_id: 'u-b-adult', type: 'system', title: 'Already pushed (B)', body: null, related_type: null, related_id: null,
      send_at: '2026-09-30T09:00:00.000Z', created_at: '2026-09-30T09:00:00.000Z', pushed_at: '2026-09-30T09:05:00.000Z',
    },
  ]);
}

const cronRequest = (authorization?: string) => new NextRequest('https://bubaly.example.com/api/cron/push-scan', {
  headers: authorization ? { authorization } : {},
});
const run = () => GET(cronRequest(`Bearer ${SECRET}`));
const rowsOf = (family: string) => db.table('notifications').filter((n) => n.family_id === family);
const pushedTo = () => provider.push.mock.calls.map(([sub, payload]) => ({
  user: (sub as { endpoint: string }).endpoint.replace('https://push.example.com/', ''),
  title: (JSON.parse(payload as string) as { title: string }).title,
}));
const openWeekly = (family: Family) => db.table('chore_assignments').filter((a) => a.chore_id === `wk-${family}` && a.status === 'todo');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key-not-real');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key-not-real');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY', 'APNS_TOPIC']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  provider.push.mockReset().mockResolvedValue({ statusCode: 201 });
  provider.email.mockReset().mockResolvedValue({ ok: true });
  provider.serviceClient.mockReset().mockImplementation(() => h.db);
  households();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the push scan refuses a caller without the cron secret', () => {
  it('API-0FE523360549 JOB-90FBAEB0B37F: no Authorization header answers 401 before any read or push', async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'pushScan.unauthorized' });
    expect(provider.serviceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(provider.push).not.toHaveBeenCalled();
  });

  it('API-0FE523360549 JOB-90FBAEB0B37F: a wrong Bearer secret answers 401 before any read, push or respawn', async () => {
    const res = await GET(cronRequest('Bearer not-the-cron-secret'));
    expect(res.status).toBe(401);
    expect(provider.serviceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(provider.push).not.toHaveBeenCalled();
    expect(db.table('chore_assignments')).toHaveLength(7);
  });
});

describe('a run over two open households and a closed one', () => {
  it('API-0FE523360549 JOB-90FBAEB0B37F: the right secret files, respawns and pushes for each open family only, and emails nobody', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, families: 2, respawned: 2, failed: 0, unserved: 0, generationHeld: 0 });

    // The closed family: nothing written, respawned or pushed.
    expect(rowsOf(CLOSED)).toEqual([]);
    expect(openWeekly(CLOSED)).toEqual([]);
    // Each kid's chore reminder, to that kid.
    expect(db.table('notifications').filter((n) => n.type === 'chore_due').map((n) => [n.family_id, n.user_id, n.title]).sort()).toEqual([
      [A, 'u-a-kid', 'Chore due: Feed the cat (A)'],
      [B, 'u-b-kid', 'Chore due: Feed the cat (B)'],
    ]);
    expect(body.created).toBe(2);
    // Each open family's weekly chore is back for its kid, a week on, under the respawn key;
    // the adult who left is not given theirs again.
    for (const family of [A, B] as const) {
      expect(openWeekly(family).map((a) => [a.member_id, a.due_at])).toEqual([[kidOf(family).member, '2026-10-05T09:00:00.000Z']]);
    }
    expect(db.table('chore_assignments').filter((a) => a.member_id === 'm-a-gone' && a.status === 'todo')).toEqual([]);

    // Pushed: current members who allow push, on their own device. u-a-gone
    // left, u-b-parent turned push off, family B turned its kid's push off.
    expect(pushedTo().map((p) => `${p.user}:${p.title}`).sort()).toEqual([
      'u-a-kid:Chore due: Feed the cat (A)',
    ]);
    expect(body.pushed).toMatchObject({ notifications: 3, result: { sent: 1, failed: 0, skipped: 0 } });
    expect(body.pushed.result.withheld).toBe(2);
    // Every due row of both open families is settled, the withheld ones included.
    for (const n of [...rowsOf(A), ...rowsOf(B)]) expect(n.pushed_at, `${n.title}`).toEqual(expect.any(String));
    expect(db.table('notifications').find((n) => n.id === HANDLED_ID)?.pushed_at).toBe('2026-09-30T09:05:00.000Z');
    // The push scan leaves email to the daily run.
    expect(provider.email).not.toHaveBeenCalled();
    for (const n of db.table('notifications').filter((x) => x.type === 'chore_due')) expect(n.sent_at).toBeNull();
  });

  it('API-0FE523360549 JOB-90FBAEB0B37F: nothing derived from one household reaches the other — not a row, a respawned chore or a push', async () => {
    await run();
    for (const family of [A, B] as const) {
      const members = new Set(PEOPLE.filter((p) => p.family === family).map((p) => p.user));
      const memberIds = new Set(PEOPLE.filter((p) => p.family === family).map((p) => p.member));
      const others = FAMILIES.filter((f) => f !== family);
      expect(rowsOf(family).length).toBeGreaterThan(0);
      for (const n of rowsOf(family)) {
        expect(members.has(n.user_id as string), `${n.title} addressed in ${family}`).toBe(true);
        for (const other of others) {
          expect(String(n.title)).not.toContain(TAG[other]);
          expect(String(n.related_id ?? '')).not.toContain(other);
        }
      }
      for (const a of db.table('chore_assignments').filter((x) => x.family_id === family)) {
        expect(memberIds.has(a.member_id as string)).toBe(true);
        expect(String(a.chore_id).endsWith(family)).toBe(true);
      }
    }
    for (const p of pushedTo()) {
      const family = PEOPLE.find((x) => x.user === p.user)!.family;
      for (const other of FAMILIES.filter((f) => f !== family)) expect(p.title).not.toContain(TAG[other]);
    }
  });
});

describe('running it again, and a run that could not do everything', () => {
  it('API-0FE523360549 JOB-90FBAEB0B37F: a second run files, respawns and pushes nothing new', async () => {
    expect((await run()).status).toBe(200);
    const notices = db.table('notifications').length;
    const assignments = db.table('chore_assignments').length;
    const pushes = provider.push.mock.calls.length;
    const second = await run();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, created: 0, respawned: 0, pushed: { notifications: 0 }, failed: 0 });
    expect(db.table('notifications')).toHaveLength(notices);
    expect(db.table('chore_assignments')).toHaveLength(assignments);
    expect(provider.push).toHaveBeenCalledTimes(pushes);
  });

  it('API-0FE523360549 JOB-90FBAEB0B37F: a refused families read answers 500 and files, respawns and pushes nothing', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'range') ? { code: '57014', message: 'statement timeout' } : null));
    const res = await run();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'pushScan.pushScanProcessingFailed' });
    expect(db.table('notifications')).toHaveLength(2);
    expect(db.table('chore_assignments')).toHaveLength(7);
    expect(provider.push).not.toHaveBeenCalled();
  });

  it('API-0FE523360549 JOB-90FBAEB0B37F: one family\'s refused recurring-chore read fails the run (502), the other family is still respawned and pushed, and the next run catches up once', async () => {
    const recurringOfB = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && c.args[0] === 'id, recurrence')
      && calls.some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === B);
    h.db = withFaults(db, (table, calls) => (table === 'chores' && recurringOfB(calls) ? { code: '57014', message: 'statement timeout' } : null));
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, respawned: 1, failed: 1 });
    expect(openWeekly(A)).toHaveLength(1);
    expect(openWeekly(B)).toEqual([]);
    expect(pushedTo().map((p) => p.user)).toContain('u-a-kid');

    h.db = db;
    const next = await run();
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ ok: true, respawned: 1 });
    expect(openWeekly(A)).toHaveLength(1);
    expect(openWeekly(B)).toHaveLength(1);
  });
});
