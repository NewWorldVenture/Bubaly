// The weekly digest (app/api/cron/weekly-digest/route.ts), driven end to end
// through its real GET over a populated two-household database.
//
// What the neighbouring tests already prove, each with the route's collaborators
// mocked (cron auth always true, sendReactEmail a recorder, the template null):
//   - a-weekly-email-is-sent-once-per-slot-whoever-calls: one idempotency key per
//     family, recipient and slot; the calendar window is the slot's week.
//   - a-closed-family-gets-no-weekly-digest: a closed family is skipped.
//   - the-weekly-digest-reaches-every-family: auth paging, 500 on failed family /
//     recipient read, 502 on a failed send, skip accounting.
//   - the-weekly-digest-reaches-a-parent-who-can-read-it: which manager is chosen.
//   - weekly-digest-email-preference: opt-out, failed preference read, 401 before
//     any SDK request (with cron-auth mocked).
//
// What this file adds: the REAL cron-auth check against CRON_SECRET; the real
// lib/email, the real template and the real Resend SDK, stubbed only at its HTTP
// boundary (tests/helpers/fake-resend-http.ts); the real listAllAuthUsers; the
// in-memory database with real filters. On that it pins: what each family's
// email actually says (only its own counts, names and lines), the skips a
// populated run must make (closed family, opted-out parent, removed member),
// that the run writes nothing to the database, that a second tick of the same
// slot delivers nothing new, and that a failed read is reported, not papered
// over. The calendar read belongs to another agent and is stubbed; this file
// only uses it to put a family-scoped line into each email.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { createFakeResendHttp } from './helpers/fake-resend-http';

const h = vi.hoisted(() => ({
  db: null as unknown,
  createServiceClient: null as unknown as (() => unknown),
  calendarCalls: [] as string[],
  listUsersCalls: 0,
  authUsersError: null as { message: string } | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: (...args: unknown[]) => (h.createServiceClient as (...a: unknown[]) => unknown)(...args) }));
// Another agent's area (calendar): stubbed. It answers one native event per
// family, titled after the family id it was ASKED for, so a line in an email
// shows which family's read fed it.
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  readCompleteCalendarOccurrences: async (scope: { familyId: string }) => {
    h.calendarCalls.push(scope.familyId);
    return {
      ok: true,
      data: {
        occurrences: [{
          kind: 'native', all_day: false, startDate: null,
          starts_at: '2026-10-07T18:00:00.000Z',
          event: { id: `00000000-0000-4000-8000-0000000e${scope.familyId.slice(-4)}`, title: `Event-of-${scope.familyId.slice(-4)}` },
        }],
        totalVisibleCount: 1, horizonEndsAt: '',
      },
    };
  },
}));

import { GET } from '@/app/api/cron/weekly-digest/route';

const SECRET = 'test-cron-secret-not-real';
const SLOT_TICK = '2026-10-05T08:00:00.000Z';

const FAM_A = '00000000-0000-4000-8000-00000000a001';
const FAM_B = '00000000-0000-4000-8000-00000000b002';
const FAM_CLOSED = '00000000-0000-4000-8000-00000000c003';
const FAM_OPTED_OUT = '00000000-0000-4000-8000-00000000d004';

const U_ANA = '00000000-0000-4000-8000-0000000000a1';
const U_REX = '00000000-0000-4000-8000-0000000000a2'; // removed from A, joined first
const U_BO = '00000000-0000-4000-8000-0000000000b1';
const U_CLO = '00000000-0000-4000-8000-0000000000c1';
const U_DEE = '00000000-0000-4000-8000-0000000000d1';

const ANA = 'ana@example.com';
const REX = 'rex@example.com';
const BO = 'bo@example.com';
const CLO = 'clo@example.com';
const DEE = 'dee@example.com';

let base: InMemorySupabase;
let resend: ReturnType<typeof createFakeResendHttp>;

function seed(db: InMemorySupabase) {
  db.seed('families', [
    { id: FAM_A, name: 'Alderfam', timezone: 'America/Los_Angeles', closed_at: null },
    { id: FAM_B, name: 'Birchfam', timezone: 'Asia/Tokyo', closed_at: null },
    { id: FAM_CLOSED, name: 'Cedarfam', timezone: 'UTC', closed_at: '2026-09-01T00:00:00.000Z' },
    { id: FAM_OPTED_OUT, name: 'Dogwoodfam', timezone: 'UTC', closed_at: null },
  ]);
  db.seed('family_members', [
    // A: a removed parent who joined first and still has a login and email,
    // the active parent, and a child without a login.
    { id: '00000000-0000-4000-8000-00000000a0m0', family_id: FAM_A, user_id: U_REX, display_name: 'Rexname', role: 'parent', is_active: false, created_at: '2025-01-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-00000000a0m1', family_id: FAM_A, user_id: U_ANA, display_name: 'Ananame', role: 'parent', is_active: true, created_at: '2025-02-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-00000000a0m2', family_id: FAM_A, user_id: null, display_name: 'Kidname', role: 'child', is_active: true, created_at: '2025-03-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-00000000b0m1', family_id: FAM_B, user_id: U_BO, display_name: 'Boname', role: 'adult', is_active: true, created_at: '2025-02-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-00000000c0m1', family_id: FAM_CLOSED, user_id: U_CLO, display_name: 'Cloname', role: 'parent', is_active: true, created_at: '2025-02-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-00000000d0m1', family_id: FAM_OPTED_OUT, user_id: U_DEE, display_name: 'Deename', role: 'parent', is_active: true, created_at: '2025-02-01T00:00:00.000Z' },
  ]);
  db.seed('user_preferences', [
    { user_id: U_DEE, email_enabled: false },
    { user_id: U_ANA, email_enabled: true },
  ]);
  // A: three open (todo/in_progress) and one done; B: one open.
  db.seed('chore_assignments', [
    { id: '00000000-0000-4000-8000-00000000a0c1', family_id: FAM_A, status: 'todo' },
    { id: '00000000-0000-4000-8000-00000000a0c2', family_id: FAM_A, status: 'in_progress' },
    { id: '00000000-0000-4000-8000-00000000a0c3', family_id: FAM_A, status: 'todo' },
    { id: '00000000-0000-4000-8000-00000000a0c4', family_id: FAM_A, status: 'done' },
    { id: '00000000-0000-4000-8000-00000000b0c1', family_id: FAM_B, status: 'todo' },
  ]);
  // A: two meals in its Monday-to-Sunday week, one the Monday after (outside).
  // B: five meals in its week.
  db.seed('meal_plans', [
    { id: '00000000-0000-4000-8000-00000000a0p1', family_id: FAM_A, plan_date: '2026-10-06' },
    { id: '00000000-0000-4000-8000-00000000a0p2', family_id: FAM_A, plan_date: '2026-10-11' },
    { id: '00000000-0000-4000-8000-00000000a0p3', family_id: FAM_A, plan_date: '2026-10-12' },
    ...['05', '06', '07', '08', '09'].map((d) => ({ id: `00000000-0000-4000-8000-00000000b0p${d.slice(1)}`, family_id: FAM_B, plan_date: `2026-10-${d}` })),
  ]);
}

/** The real listAllAuthUsers pages `auth.admin.listUsers`; the fake has no admin API, so it gets one. */
function withAuthUsers(db: InMemorySupabase) {
  const users = [
    { id: U_ANA, email: ANA }, { id: U_REX, email: REX }, { id: U_BO, email: BO },
    { id: U_CLO, email: CLO }, { id: U_DEE, email: DEE },
  ];
  Object.assign(db.auth, {
    admin: {
      listUsers: async ({ page = 1 }: { page?: number } = {}) => {
        h.listUsersCalls += 1;
        if (h.authUsersError) return { data: null, error: h.authUsersError };
        return { data: { users: page === 1 ? users : [] }, error: null };
      },
    },
  });
}

const run = (authorization?: string) => GET(new NextRequest('https://bubaly.test/api/cron/weekly-digest',
  authorization === undefined ? {} : { headers: { authorization } }));
const runAuthorized = () => run(`Bearer ${SECRET}`);

/** The HTML the real template rendered for one recipient, as Resend received it. */
function htmlTo(to: string): string {
  const delivered = resend.inbox.filter((m) => m.to === to);
  expect(delivered, `one digest delivered to ${to}`).toHaveLength(1);
  return String((JSON.parse(delivered[0].body) as { html: string }).html);
}
function subjectTo(to: string): string {
  const delivered = resend.inbox.filter((m) => m.to === to);
  expect(delivered, `one digest delivered to ${to}`).toHaveLength(1);
  return String((JSON.parse(delivered[0].body) as { subject: string }).subject);
}
/** The four stat tiles, in template order: Events, Open chores, Meals planned, Members. */
function tiles(html: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of html.matchAll(/>(\d+)<\/p><p[^>]*>(Events|Open chores|Meals planned|Members)<\/p>/g)) out[m[2]] = Number(m[1]);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SLOT_TICK));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('RESEND_API_KEY', 're_synthetic_not_real');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  h.calendarCalls = [];
  h.listUsersCalls = 0;
  h.authUsersError = null;
  base = createInMemorySupabase();
  seed(base);
  withAuthUsers(base);
  h.db = base;
  h.createServiceClient = vi.fn(() => h.db);
  resend = createFakeResendHttp();
  vi.stubGlobal('fetch', resend.fetchImpl);
});
afterEach(() => {
  expect(resend.stray, 'no request left for any host but the fake Resend').toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the weekly digest cron, authorization against the real CRON_SECRET check', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong Bearer secret', 'Bearer not-the-cron-secret'],
  ])('API-F536B0FB53D0 JOB-501B610A6401: refuses %s with 401 before any read or send', async (_label, header) => {
    const res = await run(header);
    expect(res.status).toBe(401);
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expect(base.log).toEqual([]);
    expect(h.listUsersCalls).toBe(0);
    expect(h.calendarCalls).toEqual([]);
    expect(resend.requests).toEqual([]);
  });

  it('API-F536B0FB53D0 JOB-501B610A6401: the right Bearer secret runs the job and answers 200', async () => {
    const res = await runAuthorized();
    expect(res.status).toBe(200);
    expect(h.createServiceClient).toHaveBeenCalledTimes(1);
    expect(resend.requests.length).toBeGreaterThan(0);
  });
});

describe('the weekly digest cron over two households and the rows it must skip', () => {
  it('API-F536B0FB53D0 JOB-501B610A6401: emails each open family once, and skips the closed family, the opted-out parent and the removed member', async () => {
    const res = await runAuthorized();
    expect(res.status).toBe(200);
    // A and B sent; Dogwood's only parent opted out (skipped); Cedar is closed (never read).
    expect(await res.json()).toEqual({ sent: 2, failed: 0, skipped: 1 });
    expect(resend.inbox.map((m) => m.to).sort()).toEqual([ANA, BO]);
    expect(resend.deliveredTo(REX), 'a removed member was emailed').toBe(0);
    expect(resend.deliveredTo(CLO), 'a closed family was emailed').toBe(0);
    expect(resend.deliveredTo(DEE), 'an opted-out parent was emailed').toBe(0);
    // The closed family's data is never even read.
    expect(h.calendarCalls.sort()).toEqual([FAM_A, FAM_B, FAM_OPTED_OUT].sort());
    expect(resend.inbox.every((m) => /^weekly-digest\/[0-9a-f]{64}$/.test(m.key ?? ''))).toBe(true);
  });

  it('API-F536B0FB53D0 JOB-501B610A6401: writes nothing to the database', async () => {
    const before = JSON.stringify(['families', 'family_members', 'user_preferences', 'chore_assignments', 'meal_plans'].map((t) => base.table(t)));
    await runAuthorized();
    const after = JSON.stringify(['families', 'family_members', 'user_preferences', 'chore_assignments', 'meal_plans'].map((t) => base.table(t)));
    expect(after).toBe(before);
  });
});

describe('the weekly digest cron keeps each family\'s week to that family', () => {
  it('API-F536B0FB53D0 JOB-501B610A6401: each email carries only its own family\'s name, counts, members and lines', async () => {
    await runAuthorized();
    const a = htmlTo(ANA);
    const b = htmlTo(BO);
    expect(subjectTo(ANA)).toBe('Alderfam — your week ahead');
    expect(subjectTo(BO)).toBe('Birchfam — your week ahead');

    // A: 3 open chores (done excluded), 2 meals in its week (the next Monday
    // excluded), 2 active members (the removed parent excluded), its one event.
    expect(tiles(a)).toEqual({ Events: 1, 'Open chores': 3, 'Meals planned': 2, Members: 2 });
    expect(tiles(b)).toEqual({ Events: 1, 'Open chores': 1, 'Meals planned': 5, Members: 1 });

    expect(a).toContain('Ananame');
    expect(a).toContain('Alderfam');
    expect(a).toContain(`Event-of-${FAM_A.slice(-4)}`);
    expect(b).toContain('Boname');
    expect(b).toContain('Birchfam');
    expect(b).toContain(`Event-of-${FAM_B.slice(-4)}`);

    for (const leak of ['Alderfam', 'Ananame', 'Kidname', 'Rexname', `Event-of-${FAM_A.slice(-4)}`]) expect(b, `A's "${leak}" reached B`).not.toContain(leak);
    for (const leak of ['Birchfam', 'Boname', `Event-of-${FAM_B.slice(-4)}`]) expect(a, `B's "${leak}" reached A`).not.toContain(leak);
    for (const other of ['Cedarfam', 'Cloname', 'Dogwoodfam', 'Deename', 'Rexname']) {
      expect(a).not.toContain(other);
      expect(b).not.toContain(other);
    }
  });
});

describe('the weekly digest cron, a second tick and a failed read', () => {
  it('API-F536B0FB53D0 JOB-501B610A6401: a second tick of the same slot delivers nothing new and still skips the same rows', async () => {
    expect((await runAuthorized()).status).toBe(200);
    const firstKeys = resend.requests.map((r) => r.key);
    vi.setSystemTime(new Date('2026-10-05T08:03:30.000Z')); // the mirrored dispatcher tick
    const second = await runAuthorized();
    expect(second.status).toBe(200);
    // Same bytes under the same keys (a different body would be a 409 and a
    // failure here); the provider folds them.
    expect(resend.requests.slice(firstKeys.length).map((r) => r.key)).toEqual(firstKeys);
    expect(resend.inbox).toHaveLength(2);
    expect(resend.deliveredTo(ANA)).toBe(1);
    expect(resend.deliveredTo(BO)).toBe(1);
    expect(resend.deliveredTo(DEE)).toBe(0);
  });

  it('API-F536B0FB53D0 JOB-501B610A6401: one family\'s failed meal read answers 502 with the failure counted, and the other family is still served', async () => {
    h.db = withFaults(base, (table, calls) =>
      table === 'meal_plans' && calls.some((c) => c.method === 'eq' && c.args[1] === FAM_A) ? { message: 'synthetic meal read failure' } : null);
    const res = await runAuthorized();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 1, failed: 1, skipped: 1 });
    expect(resend.deliveredTo(ANA), 'a digest was built from a failed read').toBe(0);
    expect(resend.deliveredTo(BO)).toBe(1);
    expect(tiles(htmlTo(BO))['Meals planned']).toBe(5);
  });

  it('API-F536B0FB53D0 JOB-501B610A6401: a failed recipient read answers 500 and sends nothing', async () => {
    h.authUsersError = { message: 'synthetic auth admin failure' };
    const res = await runAuthorized();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'weeklyDigest.weeklyDigestProcessingFailed' });
    expect(resend.requests).toEqual([]);
  });

  it('API-F536B0FB53D0 JOB-501B610A6401: a provider refusal for one family answers 502 and is not counted as sent', async () => {
    resend.script = ({ to }) => (to === ANA ? 'reject_429' : 'accept');
    const res = await runAuthorized();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 1, failed: 1, skipped: 1 });
    expect(resend.deliveredTo(ANA)).toBe(0);
    expect(resend.deliveredTo(BO)).toBe(1);
  });
});
