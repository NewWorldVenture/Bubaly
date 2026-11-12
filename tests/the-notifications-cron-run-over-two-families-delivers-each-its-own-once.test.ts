// GET /api/cron/notifications (API-F06602E9AAE7, JOB-947DBEA75C2A), driven
// through the real exported handler, the real cron-secret check, the real
// generator, morning brief, approval sweeps, push dispatch and email digest,
// over the in-memory database. Only the providers are stubbed, at the seams the
// existing tests stub them: `web-push` (push-delivery-retry.test.ts), the
// endpoint DNS check, and `@/lib/email` (a-closed-family-is-left-alone-by-the-crons.test.ts).
// The auth-user listing is the in-memory client's `auth.admin.listUsers`, so
// lib/server/list-all-auth-users.ts runs as written.
//
// What the existing tests already prove, and so is not repeated here:
// - a-closed-family-is-left-alone-by-the-crons: the route skips a closed
//   family (generator mocked), and dispatch/email/brief/approvals each skip one.
// - push-delivery-retry: a provider failure / missing provider config / cursor
//   failure answers 502 and is retried, on a fixture db with generation mocked.
// - an-approval-sweep-that-did-not-run-fails-the-cron: a sweep failure is 502.
// - a-slow-*-cannot-starve-delivery, whole-table-reads-are-not-capped: budgets
//   and paging. cron-notification-failure-status / notification-email-boundary:
//   source pins of the failure sum.
// New here: one populated run over two open households and a closed one, with
// a removed member, a push opt-out, an email opt-out and a family that turned
// its children's channels off — what was written, pushed and emailed, per
// family; a second run; and a refused read in one family or one step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

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
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  emailEnabled: () => true,
  sendReactEmail: provider.email,
}));

const { GET } = await import('@/app/api/cron/notifications/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-09-30T12:00:00.000Z';
const A = 'fam-a';
const B = 'fam-b';
const CLOSED = 'fam-c';

type Person = { member: string; user: string; family: string; role: string; active: boolean; email: string };
const PEOPLE: Person[] = [
  // A: the parent turned email off; an adult has left the family.
  { member: 'm-a-parent', user: 'u-a-parent', family: A, role: 'parent', active: true, email: 'parent.a@example.com' },
  { member: 'm-a-kid', user: 'u-a-kid', family: A, role: 'child', active: true, email: 'kid.a@example.com' },
  { member: 'm-a-gone', user: 'u-a-gone', family: A, role: 'adult', active: false, email: 'gone.a@example.com' },
  // B: the parent turned push off; the family turned its children's push and email off.
  { member: 'm-b-parent', user: 'u-b-parent', family: B, role: 'parent', active: true, email: 'parent.b@example.com' },
  { member: 'm-b-adult', user: 'u-b-adult', family: B, role: 'adult', active: true, email: 'adult.b@example.com' },
  { member: 'm-b-kid', user: 'u-b-kid', family: B, role: 'child', active: true, email: 'kid.b@example.com' },
  // Closed: everything an open family has.
  { member: 'm-c-parent', user: 'u-c-parent', family: CLOSED, role: 'parent', active: true, email: 'parent.c@example.com' },
  { member: 'm-c-kid', user: 'u-c-kid', family: CLOSED, role: 'child', active: true, email: 'kid.c@example.com' },
];
const TAG = { [A]: '(A)', [B]: '(B)', [CLOSED]: '(C)' } as const;
const STALE_ID = '00000000-0000-4000-8000-0000000000a1';
const HANDLED_ID = '00000000-0000-4000-8000-0000000000b1';

let db: InMemorySupabase;

function event(family: keyof typeof TAG, title: string) {
  return {
    id: `ev-${family}`, family_id: family, title: `${title} ${TAG[family]}`, starts_at: '2026-09-30T18:00:00.000Z', ends_at: '2026-09-30T19:00:00.000Z',
    all_day: false, location: null, description: null, category: 'general', recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null,
    external_uid: null, created_by: null, onboarding_key: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

function households() {
  db = createInMemorySupabase({
    defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } },
    uniques: { app_settings: [['key']] },
  });
  Object.assign(db.auth, {
    admin: {
      listUsers: async ({ page }: { page?: number } = {}) => ({
        data: { users: page === 1 ? PEOPLE.map((p) => ({ id: p.user, email: p.email, user_metadata: {} })) : [] }, error: null,
      }),
    },
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
  db.seed('user_preferences', [
    { user_id: 'u-a-parent', email_enabled: false, push_enabled: true },
    { user_id: 'u-b-parent', email_enabled: true, push_enabled: false },
  ]);
  db.seed('family_ai_settings', [{ family_id: B, child_channels: { push: false, email: false } }]);
  for (const family of [A, B, CLOSED] as const) {
    const kid = PEOPLE.find((p) => p.family === family && p.role === 'child')!;
    db.seed('chores', [{ id: `ch-${family}`, family_id: family, title: `Feed the cat ${TAG[family]}` }]);
    db.seed('chore_assignments', [{ id: `ca-${family}`, family_id: family, chore_id: `ch-${family}`, member_id: kid.member, status: 'todo', due_at: '2026-09-30T15:00:00.000Z' }]);
  }
  // A chore still assigned to the adult who left family A.
  db.seed('chores', [{ id: 'ch-a-gone', family_id: A, title: 'Rake leaves (A)' }]);
  db.seed('chore_assignments', [{ id: 'ca-a-gone', family_id: A, chore_id: 'ch-a-gone', member_id: 'm-a-gone', status: 'todo', due_at: '2026-09-30T16:00:00.000Z' }]);
  db.seed('calendar_events', [event(A, 'Swim gala'), event(B, 'Recital'), event(CLOSED, 'Bake sale')]);
  db.seed('notifications', [
    // Queued for the adult before they left family A.
    {
      id: STALE_ID, family_id: A, user_id: 'u-a-gone', type: 'system', title: 'Old notice (A)', body: null, related_type: null, related_id: null,
      send_at: '2026-09-30T11:00:00.000Z', created_at: '2026-09-30T11:00:00.000Z',
    },
    // Already pushed and emailed by an earlier run.
    {
      id: HANDLED_ID, family_id: B, user_id: 'u-b-adult', type: 'system', title: 'Already delivered (B)', body: null, related_type: null, related_id: null,
      send_at: '2026-09-30T09:00:00.000Z', created_at: '2026-09-30T09:00:00.000Z', pushed_at: '2026-09-30T09:05:00.000Z', sent_at: '2026-09-30T09:05:00.000Z',
    },
  ]);
}

const cronRequest = (authorization?: string) => new NextRequest('https://bubaly.example.com/api/cron/notifications', {
  headers: authorization ? { authorization } : {},
});
const run = () => GET(cronRequest(`Bearer ${SECRET}`));
const rowsOf = (family: string) => db.table('notifications').filter((n) => n.family_id === family);
const pushedTo = () => provider.push.mock.calls.map(([sub, payload]) => ({
  endpoint: (sub as { endpoint: string }).endpoint.replace('https://push.example.com/', ''),
  title: (JSON.parse(payload as string) as { title: string }).title,
}));
const emailed = () => provider.email.mock.calls.map(([message]) => ({
  to: (message as { to: string }).to,
  titles: ((message as { react: { props: { items: { title: string }[] } } }).react.props.items).map((i) => i.title).sort(),
}));
const otherTags = (family: keyof typeof TAG) => Object.entries(TAG).filter(([f]) => f !== family).map(([, tag]) => tag);

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

describe('the notifications cron refuses a caller without the cron secret', () => {
  it('API-F06602E9AAE7 JOB-947DBEA75C2A: no Authorization header answers 401 before any read, push or email', async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'notifications.unauthorized' });
    expect(provider.serviceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(provider.push).not.toHaveBeenCalled();
    expect(provider.email).not.toHaveBeenCalled();
  });

  it('API-F06602E9AAE7 JOB-947DBEA75C2A: a wrong Bearer secret answers 401 before any read, push or email', async () => {
    const res = await GET(cronRequest('Bearer not-the-cron-secret'));
    expect(res.status).toBe(401);
    expect(provider.serviceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(provider.push).not.toHaveBeenCalled();
    expect(provider.email).not.toHaveBeenCalled();
    expect(db.table('notifications')).toHaveLength(2);
  });
});

describe('a run over two open households and a closed one', () => {
  it('API-F06602E9AAE7 JOB-947DBEA75C2A: the right secret generates, pushes and emails each open family\'s own notices, and nothing for the closed one', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, families: 2, failed: 0, unserved: 0, generationHeld: 0, briefs: { families: 2, failed: 0 } });

    // The closed family: nothing written, pushed or emailed.
    expect(rowsOf(CLOSED)).toEqual([]);
    // The adult who left family A is addressed by nothing this run wrote
    // (whoever their still-open chore now reaches — see the report's owner decision).
    expect(db.table('notifications').filter((n) => n.user_id === 'u-a-gone').map((n) => n.id)).toEqual([STALE_ID]);
    // Each kid's chore reminder, addressed to that kid.
    expect(db.table('notifications').filter((n) => n.type === 'chore_due' && String(n.related_id).startsWith('ca-fam')).map((n) => [n.family_id, n.user_id, n.title]).sort()).toEqual([
      [A, 'u-a-kid', 'Chore due: Feed the cat (A)'],
      [B, 'u-b-kid', 'Chore due: Feed the cat (B)'],
    ]);
    // The family-wide event, one row per current member with a login, never the one who left.
    expect(db.table('notifications').filter((n) => n.type === 'calendar_event').map((n) => `${n.family_id}:${n.user_id}`).sort()).toEqual([
      `${A}:u-a-kid`, `${A}:u-a-parent`, `${B}:u-b-adult`, `${B}:u-b-kid`, `${B}:u-b-parent`,
    ]);
    // The morning brief: once per manager of each open family.
    expect(db.table('notifications').filter((n) => n.related_type === 'brief').map((n) => n.user_id).sort()).toEqual(['u-a-parent', 'u-b-adult', 'u-b-parent']);
    expect(body.created).toBe(db.table('notifications').filter((n) => n.related_type !== 'brief').length - 2);

    // Pushed: only current members who allow push, on their own device.
    // u-a-gone left, u-b-parent turned push off, family B turned its kid's push off.
    expect([...new Set(pushedTo().map((p) => p.endpoint))].sort()).toEqual(['u-a-kid', 'u-a-parent', 'u-b-adult']);
    expect(pushedTo().filter((p) => p.endpoint === 'u-a-kid').map((p) => p.title)).toContain('Chore due: Feed the cat (A)');
    expect(pushedTo().map((p) => p.title)).not.toContain('Already delivered (B)');
    expect(pushedTo().map((p) => p.title)).not.toContain('Old notice (A)');
    expect(body.pushed.result).toMatchObject({ sent: pushedTo().length, failed: 0, skipped: 0 });
    expect(body.pushed.result.withheld).toBeGreaterThan(0);

    // Emailed: one digest per recipient who allows email, of their own rows.
    // u-a-parent turned email off; family B turned its kid's email off; u-a-gone left.
    expect(emailed().sort((x, y) => x.to.localeCompare(y.to))).toEqual([
      { to: 'adult.b@example.com', titles: ['Morning brief: 1 thing today.'] },
      { to: 'kid.a@example.com', titles: ['Chore due: Feed the cat (A)'] },
      { to: 'parent.b@example.com', titles: ['Morning brief: 1 thing today.'] },
    ]);
    expect(body).toMatchObject({ emailed: 3, emailFailures: 0, emailSkipped: 3 });

    // Every due row of both open families is settled on both channels,
    // the withheld ones (opt-outs, the member who left) included.
    for (const n of [...rowsOf(A), ...rowsOf(B)]) {
      expect(n.pushed_at, `${n.title} pushed_at`).toEqual(expect.any(String));
      expect(n.sent_at, `${n.title} sent_at`).toEqual(expect.any(String));
    }
    expect(db.table('notifications').find((n) => n.id === HANDLED_ID)).toMatchObject({ pushed_at: '2026-09-30T09:05:00.000Z', sent_at: '2026-09-30T09:05:00.000Z' });
  });

  it('API-F06602E9AAE7 JOB-947DBEA75C2A: nothing derived from one household reaches the other — not a row, a push or an email line', async () => {
    await run();
    for (const family of [A, B] as const) {
      const rows = rowsOf(family);
      expect(rows.length).toBeGreaterThan(0);
      const members = new Set(PEOPLE.filter((p) => p.family === family).map((p) => p.user));
      for (const n of rows) {
        expect(members.has(n.user_id as string), `${n.title} addressed in ${family}`).toBe(true);
        for (const tag of otherTags(family)) expect(String(n.title)).not.toContain(tag);
        for (const id of ['ev', 'ca', 'ch'].flatMap((p) => [A, B, CLOSED].filter((f) => f !== family).map((f) => `${p}-${f}`))) {
          expect(String(n.related_id ?? '')).not.toContain(id);
        }
      }
    }
    // Each device and each inbox saw only its own family's tagged notices.
    for (const p of pushedTo()) {
      const family = PEOPLE.find((x) => x.user === p.endpoint)!.family as keyof typeof TAG;
      for (const tag of otherTags(family)) expect(p.title).not.toContain(tag);
    }
    for (const e of emailed()) {
      const family = PEOPLE.find((x) => x.email === e.to)!.family as keyof typeof TAG;
      for (const title of e.titles) for (const tag of otherTags(family)) expect(title).not.toContain(tag);
    }
  });
});

describe('running it again, and a run that could not do everything', () => {
  it('API-F06602E9AAE7 JOB-947DBEA75C2A: a second run writes, pushes and emails nothing new', async () => {
    expect((await run()).status).toBe(200);
    const rows = db.table('notifications').length;
    const pushes = provider.push.mock.calls.length;
    const emails = provider.email.mock.calls.length;
    const second = await run();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, created: 0, briefs: { delivered: 0 }, pushed: { notifications: 0 }, emailed: 0, failed: 0 });
    expect(db.table('notifications')).toHaveLength(rows);
    expect(provider.push).toHaveBeenCalledTimes(pushes);
    expect(provider.email).toHaveBeenCalledTimes(emails);
  });

  it('API-F06602E9AAE7 JOB-947DBEA75C2A: a refused families read answers 500 and writes, pushes and emails nothing', async () => {
    h.db = withFaults(db, (table) => (table === 'families' ? { code: '57014', message: 'statement timeout' } : null));
    const res = await run();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'notifications.notificationProcessingFailed' });
    expect(db.table('notifications')).toHaveLength(2);
    expect(provider.push).not.toHaveBeenCalled();
    expect(provider.email).not.toHaveBeenCalled();
  });

  it('API-F06602E9AAE7 JOB-947DBEA75C2A: one family\'s refused chore read fails the run (502), the other family is still served, and the next run catches up once', async () => {
    const familyB = (calls: FaultCall[]) => calls.some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === B);
    h.db = withFaults(db, (table, calls) => (table === 'chore_assignments' && familyB(calls) ? { code: '57014', message: 'statement timeout' } : null));
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, failed: 1 });
    const feedTheCat = () => db.table('notifications').filter((n) => String(n.title).startsWith('Chore due: Feed the cat'));
    expect(feedTheCat().map((n) => n.user_id)).toEqual(['u-a-kid']);
    expect(emailed().map((e) => e.to)).toContain('kid.a@example.com');
    expect(pushedTo().filter((p) => p.endpoint === 'u-a-kid').map((p) => p.title)).toContain('Chore due: Feed the cat (A)');

    h.db = db;
    provider.push.mockClear();
    provider.email.mockClear();
    const next = await run();
    expect(next.status).toBe(200);
    expect(feedTheCat().map((n) => n.user_id).sort()).toEqual(['u-a-kid', 'u-b-kid']);
    // B's kid is reached by neither channel (the family turned both off); A's chore is not sent again.
    expect(pushedTo().map((p) => p.title)).not.toContain('Chore due: Feed the cat (A)');
    expect(emailed().map((e) => e.to)).not.toContain('kid.a@example.com');
  });

  it('API-F06602E9AAE7 JOB-947DBEA75C2A: a refused email-preference read answers 502, emails nobody, keeps the rows pending, and the next run emails each digest once', async () => {
    const emailPrefs = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && String(c.args[0]).includes('email_enabled'));
    h.db = withFaults(db, (table, calls) => (table === 'user_preferences' && emailPrefs(calls) ? { code: '57014', message: 'statement timeout' } : null));
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, emailed: 0, emailFailures: 1 });
    expect(provider.email).not.toHaveBeenCalled();
    // Push is its own channel and still went out.
    expect(provider.push).toHaveBeenCalled();
    const chore = (user: string) => db.table('notifications').find((n) => n.related_id === 'ca-fam-a' && n.user_id === user) as Row;
    expect(chore('u-a-kid').sent_at).toBeNull();
    expect(chore('u-a-kid').pushed_at).toEqual(expect.any(String));

    h.db = db;
    expect((await run()).status).toBe(200);
    expect(emailed().map((e) => e.to).sort()).toEqual(['adult.b@example.com', 'kid.a@example.com', 'parent.b@example.com']);
    expect(chore('u-a-kid').sent_at).toEqual(expect.any(String));
    expect((await run()).status).toBe(200);
    expect(provider.email).toHaveBeenCalledTimes(3);
  });
});
