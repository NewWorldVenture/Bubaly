// POST /api/autopilot/scan, driven end to end: the real route, the real plan
// resolver and the real runAutopilotScan over an in-memory database seeded with
// two households. Only the push sender and the activity feed are stubbed — the
// seam tests/autopilot-scan-delivers-what-it-promises.test.ts stubs.
//
// Already proved elsewhere, and not repeated here:
//   tests/autopilot-plan-gate.test.ts — a Free family is 403 and nothing runs; a
//     super administrator previews past the plan; an unreadable plan is 503; the
//     scan is handed the member's role and member id.
//   tests/a-super-admin-page-and-its-endpoint-agree.test.ts — the preview rule.
//   tests/autopilot-persistence-boundaries.test.ts — the scan's own read and write failures.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

type Ctx = { user: { id: string }; active: { familyId: string; role: string; member: { id: string }; family: { id: string; timezone: string } } };
const h = vi.hoisted(() => ({ db: null as unknown, ctx: null as Ctx | null }));

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', async () => {
  const { redirect } = await import('next/navigation');
  return {
    isSuperAdmin: async () => false,
    requireUserContext: async () => {
      if (!h.ctx) redirect('/login');
      return h.ctx;
    },
  };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
const pushes = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: pushes.notify,
}));

const { POST } = await import('@/app/api/autopilot/scan/route');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const FAILED = translate(SOURCE_MESSAGES, 'scan.autopilotScanFailed');

const ID = 'API-5DF6AEE61A0B';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RENEWAL_A = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const RENEWAL_B = 'bbbbbbbb-0000-4000-8000-0000000000e1';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const memberFor = (family: string, role: string) => `${family.slice(0, 8)}-0000-4000-8000-00000000010${ROLES.indexOf(role as never)}`;
const userFor = (family: string, role: string) => `${family.slice(0, 8)}-0000-4000-8000-00000000020${ROLES.indexOf(role as never)}`;

let db: InMemorySupabase;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function signIn(family: string, role: (typeof ROLES)[number]) {
  h.ctx = {
    user: { id: userFor(family, role) },
    active: { familyId: family, role, member: { id: memberFor(family, role) }, family: { id: family, timezone: 'UTC' } },
  };
}

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
  h.db = db;
  h.ctx = null;
  pushes.notify.mockReset().mockResolvedValue({ ok: true, data: { created: 1 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  // A pays for Plus; B is on Free.
  db.seed('subscriptions', [{ family_id: FAMILY_A, plan: 'plus', status: 'active' }]);
  db.seed('family_members', [FAMILY_A, FAMILY_B].flatMap((family) => ROLES.map((role) => ({
    id: memberFor(family, role), family_id: family, user_id: userFor(family, role), role, is_active: true, display_name: role, birthday: null,
  }))));
  db.seed('renewals', [
    { id: RENEWAL_A, family_id: FAMILY_A, title: 'Passport A', expires_at: inDays(10), status: 'active' },
    { id: RENEWAL_B, family_id: FAMILY_B, title: 'Passport B', expires_at: inDays(10), status: 'active' },
  ]);
});

const cardsOf = (family: string) => db.table('autopilot_suggestions').filter((r) => r.family_id === family);
const familyBRows = () => ['autopilot_suggestions', 'reminders', 'grocery_items', 'family_digital_twin_profiles']
  .flatMap((t) => db.table(t).filter((r) => r.family_id === FAMILY_B));

describe('who may run the on-demand scan', () => {
  it(`${ID} signed-out is sent to /login before any table is read or written`, async () => {
    await expect(POST()).rejects.toThrow('NEXT_REDIRECT /login');
    expect(db.log).toEqual([]);
    expect(db.table('autopilot_suggestions')).toEqual([]);
  });

  it.each(ROLES.filter((r) => r !== 'guest'))(`${ID} a %s of the Plus household runs it and gets the renewal card, in household A only`, async (role) => {
    signIn(FAMILY_A, role);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: expect.any(Number), autoExecuted: expect.any(Number), cleared: 0, notified: expect.any(Number), policyCandidates: 0 });
    expect(cardsOf(FAMILY_A)).toEqual(expect.arrayContaining([
      expect.objectContaining({ family_id: FAMILY_A, source_kind: 'renewals', source_id: RENEWAL_A }),
    ]));
    expect(familyBRows()).toEqual([]);
  });

  it(`${ID} a guest runs it (200) but writes no renewal card, which a guest may not read (audience.ts, 0486)`, async () => {
    signIn(FAMILY_A, 'guest');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(cardsOf(FAMILY_A).filter((r) => r.source_kind === 'renewals')).toEqual([]);
    expect(familyBRows()).toEqual([]);
  });
});

describe('another household', () => {
  it(`${ID} a parent of the Free household is refused 403; neither household gains a card, reminder or push`, async () => {
    signIn(FAMILY_B, 'parent');
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: FAILED, needLevel: 2 });
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
    expect(pushes.notify).not.toHaveBeenCalled();
  });

  it(`${ID} household A's scan never reads household B's renewal into a card or a push`, async () => {
    signIn(FAMILY_A, 'parent');
    await POST();
    expect(JSON.stringify(db.table('autopilot_suggestions'))).toContain('Passport A');
    expect(JSON.stringify(db.table('autopilot_suggestions'))).not.toContain('Passport B');
    expect(JSON.stringify(pushes.notify.mock.calls)).not.toContain('Passport B');
    expect(db.table('reminders').every((r) => r.family_id === FAMILY_A)).toBe(true);
  });
});

describe('a read that fails', () => {
  it(`${ID} a failed renewals read answers 500 with the translated failure, writes no card and leaks no internal text`, async () => {
    signIn(FAMILY_A, 'parent');
    h.db = withFaults(db, (table) => (table === 'renewals' ? { message: 'relation renewals: connection reset by peer' } : null));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: FAILED });
    expect(JSON.stringify(body)).not.toMatch(/connection reset|renewals|required family data/);
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(pushes.notify).not.toHaveBeenCalled();
  });
});
