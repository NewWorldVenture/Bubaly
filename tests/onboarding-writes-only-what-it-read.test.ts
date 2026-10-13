// The onboarding actions, against the in-memory database, for six findings:
//
// A2/A10 — resetOnboardingAction read user_preferences with its error dropped,
//   so a failed read became `{}` and the upsert replaced the WHOLE
//   notification_prefs blob (App Lock, nav, shortcuts, …) with
//   `{ onboardingComplete: false }`, reporting success. Finalize step 6b did a
//   read-then-upsert of the whole blob, undoing any save that landed between.
//   The reset's membership read dropped its error and recorded a NULL family.
// A13/A20 — finalize took an unreadable onboarding_progress row for "none",
//   returned success having written nothing, and the wizard deleted the draft.
// A11 — a retry after a partial failure, with a payload that had changed (a
//   reload drops the imported events, the PIN and the receipt), keyed every
//   member and invite anew: each child added twice, each invitee invited and
//   emailed twice.
// A17 — the welcome email went to `profile.email` (caller-typed) on every
//   replayable finalize; profiles.email was overwritten with the same value.
// A8 — saveFamilyDetailsAction checked no role and took the family from the
//   input; and the CRM contact it then rewrote was whichever one the family
//   had — the owner's.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';

const mock = vi.hoisted(() => ({
  db: null as unknown, sendReactEmail: vi.fn(), saveUserProfile: vi.fn(), rateAllowed: true, epoch: 0,
  ctxRole: 'parent', ctxFamily: '20000000-0000-4000-8000-000000000001', limiterHits: new Map<string, number>(),
}));
vi.mock('@/lib/server/rate-limit', async (original) => {
  const real = await original<typeof import('@/lib/server/rate-limit')>();
  return { ...real, rateLimit: (key: string, opts?: Parameters<typeof real.rateLimit>[1]) => real.rateLimit(`${mock.epoch}:${key}`, opts) };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '10000000-0000-4000-8000-000000000001', email: 'ada@example.test' }, memberships: [],
    active: { familyId: mock.ctxFamily, role: mock.ctxRole, member: { id: 'own-row' }, family: { id: mock.ctxFamily, name: 'Ada family' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/profiles', () => ({ saveUserProfile: mock.saveUserProfile }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test', sendReactEmail: mock.sendReactEmail }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { finalizeOnboardingAction, resetOnboardingAction, saveFamilyDetailsAction } = await import('@/app/onboarding/actions');
const { resolveCompleteness } = await import('@/lib/server/onboarding-progress');

const USER = '10000000-0000-4000-8000-000000000001';
const OTHER_USER = '10000000-0000-4000-8000-000000000002';
const OWN = '20000000-0000-4000-8000-000000000001';
let db: InMemorySupabase;

const REFUSED = { data: null, error: { code: 'XX000', message: 'fixture read refused', details: null, hint: null }, count: null, status: 500, statusText: 'Error' };
/** The same database, with the calls `refuse` names answering an error — `maybeSingle` and `single` included. */
function refusing(base: InMemorySupabase, refuse: (table: string, calls: string[]) => boolean): InMemorySupabase {
  return new Proxy(base, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (table: string) => {
      const builder = target.from(table) as unknown as Record<string | symbol, unknown> & PromiseLike<unknown>;
      const calls: string[] = [];
      const proxy: object = new Proxy(builder, { get(object, k) {
        if (k === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (refuse(table, calls) ? Promise.resolve(REFUSED).then(res, rej) : object.then(res, rej));
        const value = Reflect.get(object, k);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(k));
          if ((k === 'maybeSingle' || k === 'single') && refuse(table, calls)) return Promise.resolve(REFUSED);
          const result = Reflect.apply(value, object, args);
          return result === object ? proxy : result;
        };
      } });
      return proxy;
    };
  } });
}

/** The same database, where `after` runs once, as soon as the first read of `column` from `table` has answered: another writer landing between that read and the write after it. */
function racing(base: InMemorySupabase, table: string, column: string, after: () => void): InMemorySupabase {
  let fired = false;
  const fire = <T,>(value: T): T => { if (!fired) { fired = true; after(); } return value; };
  return new Proxy(base, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (name: string) => {
      const builder = target.from(name) as unknown as Record<string | symbol, unknown> & PromiseLike<unknown>;
      if (name !== table) return builder;
      const calls: string[] = [];
      let reads = false;
      const proxy: object = new Proxy(builder, { get(object, k) {
        if (k === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => object.then((v) => (reads ? fire(v) : v)).then(res, rej);
        const value = Reflect.get(object, k);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (calls.length === 0 && k === 'select' && String(args[0] ?? '').includes(column)) reads = true;
          calls.push(String(k));
          const result = Reflect.apply(value, object, args);
          if ((k === 'maybeSingle' || k === 'single') && reads) return Promise.resolve(result).then(fire);
          return result === object ? proxy : result;
        };
      } });
      return proxy;
    };
  } });
}

function build(options: { claims?: boolean } = {}) {
  db = createInMemorySupabase({
    userId: USER,
    uniques: { family_members: [['family_id', 'user_id'], ['family_id', 'onboarding_key']], user_preferences: [['user_id']], onboarding_progress: [['user_id']],
      invites: [['family_id', 'onboarding_key']], calendar_events: [['family_id', 'onboarding_key']], onboarding_imports: [['family_id', 'onboarding_key']] },
    rpc: {
      onboarding_claim_family: (_args, mem) => {
        // 0454: the claim records the wizard as in progress for this family.
        const row = mem.table('onboarding_progress').find((p) => p.user_id === USER);
        if (row) Object.assign(row, { family_id: OWN, source: 'wizard', status: 'in_progress' });
        else mem.table('onboarding_progress').push({ id: 'op', user_id: USER, family_id: OWN, source: 'wizard', status: 'in_progress' });
        return options.claims === false ? [] : [{ family_id: OWN, created: true }];
      },
      rate_limit_hit: (args) => {
        const key = String(args.p_key ?? args.key ?? '');
        mock.limiterHits.set(key, (mock.limiterHits.get(key) ?? 0) + 1);
        return [{ allowed: mock.rateAllowed, retry_after: mock.rateAllowed ? 0 : 60 }];
      },
    },
  });
  Object.assign(db.auth, { getUser: async () => ({ data: { user: { id: USER, email: 'ada@example.test', user_metadata: {} } }, error: null }) });
  db.seed('families', [{ id: OWN, created_by: USER, name: 'Ada family', timezone: 'UTC' }]);
  mock.db = db;
}

const payload = (extra: Partial<ReturnType<typeof buildFinalizePayload>> = {}) => ({
  ...buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'The Adas', timezone: 'UTC' })), ...extra,
});
const PREFS = { appLock: { enabled: true, hash: 'h', salt: 's' }, sidebarNav: ['home', 'calendar'], captureShortcuts: ['note'], onboardingComplete: true };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mock.sendReactEmail.mockReset().mockResolvedValue({ ok: true });
  mock.saveUserProfile.mockReset().mockResolvedValue({ ok: true });
  mock.rateAllowed = true;
  mock.epoch++;
  mock.limiterHits = new Map();
  mock.ctxRole = 'parent';
  mock.ctxFamily = OWN;
  build();
});

describe('resetting onboarding (A2/A10)', () => {
  beforeEach(() => {
    db.seed('user_preferences', [{ user_id: USER, notification_prefs: structuredClone(PREFS), active_family_id: OWN }]);
    db.seed('family_members', [{ id: 'own-row', family_id: OWN, user_id: USER, role: 'parent', is_active: true }]);
    db.seed('onboarding_progress', [{ id: 'op', user_id: USER, family_id: OWN, source: 'wizard', status: 'completed' }]);
  });
  const prefs = () => db.table('user_preferences')[0].notification_prefs as Record<string, unknown>;

  it('a preferences read that fails writes nothing and says so — App Lock stays on', async () => {
    mock.db = refusing(db, (table, calls) => table === 'user_preferences' && calls.includes('select') && !calls.includes('update'));
    const result = await resetOnboardingAction();
    expect(result.ok).toBe(false);
    expect(prefs()).toEqual(PREFS);
  });

  it('a reset that can read clears only the completion flag (control)', async () => {
    expect(await resetOnboardingAction()).toEqual({ ok: true });
    expect(prefs()).toEqual({ ...PREFS, onboardingComplete: false });
    expect(db.table('onboarding_progress')[0]).toMatchObject({ status: 'reset', family_id: OWN });
  });

  it('a membership read that fails does not record a NULL family over the one the row names', async () => {
    mock.db = refusing(db, (table) => table === 'family_members');
    expect(await resetOnboardingAction()).toEqual({ ok: true });
    expect(db.table('onboarding_progress')[0]).toMatchObject({ status: 'reset', family_id: OWN });
  });
});

describe('finishing onboarding (A13/A20, A10)', () => {
  it('an unreadable progress row is not "nothing to do": it fails, and writes no details, members or preferences', async () => {
    db.seed('family_members', [{ id: 'own-row', family_id: OWN, user_id: USER, role: 'parent', is_active: true, created_at: '2026-01-01' }]);
    mock.db = refusing(db, (table) => table === 'onboarding_progress');
    const result = await finalizeOnboardingAction(payload({ members: [{ kind: 'local', name: 'Ava', role: 'child' }] }));
    expect(result.ok).toBe(false);
    expect(db.table('family_onboarding')).toEqual([]);
    expect(db.table('family_members').filter((m) => m.display_name === 'Ava')).toEqual([]);
    expect(db.table('user_preferences')).toEqual([]);
  });

  it('an absent progress row for an owner is still the idempotent re-submit it always was (control)', async () => {
    db.seed('family_members', [{ id: 'own-row', family_id: OWN, user_id: USER, role: 'parent', is_active: true, created_at: '2026-01-01' }]);
    expect(await finalizeOnboardingAction(payload())).toMatchObject({ ok: true, data: { familyId: OWN } });
  });

  it('merges its keys into preferences someone else saved, rather than writing back what it read', async () => {
    db.seed('user_preferences', [{ user_id: USER, notification_prefs: { sidebarNav: ['home'] }, updated_at: '2026-10-01T00:00:00.000Z' }]);
    let raced = false;
    // Another tab saves the navigation and a shortcut between finish's read of the blob and its write.
    mock.db = racing(db, 'user_preferences', 'notification_prefs', () => {
      raced = true;
      Object.assign(db.table('user_preferences')[0], { notification_prefs: { sidebarNav: ['home', 'money'], captureShortcuts: ['note'] }, updated_at: '2026-10-01T00:00:05.000Z' });
    });
    const result = await finalizeOnboardingAction(payload({ appearance: { pin: '1234', age: 38 } }));
    expect(result.ok).toBe(true);
    expect(raced).toBe(true);
    expect(db.table('user_preferences')).toHaveLength(1);
    const saved = db.table('user_preferences')[0].notification_prefs as Record<string, unknown>;
    expect(saved).toMatchObject({ onboardingComplete: true, age: 38, appLock: expect.objectContaining({ enabled: false }) });
    expect(saved).toMatchObject({ sidebarNav: ['home', 'money'], captureShortcuts: ['note'] });
  });

  it('the setup page is told which completeness reads did not answer', async () => {
    mock.db = refusing(db, (table) => table === 'onboarding_progress' || table === 'family_onboarding');
    const { readFailures } = await resolveCompleteness(mock.db as never, USER, OWN);
    expect(readFailures.sort()).toEqual(['family_onboarding', 'onboarding_progress']);
    expect((await resolveCompleteness(db as never, USER, OWN)).readFailures).toEqual([]);
  });
});

describe('a retried finish does not add the household twice (A11)', () => {
  const household = [
    { kind: 'local' as const, name: 'Ava', role: 'child' as const },
    { kind: 'invite' as const, email: 'grandpa@example.test', role: 'guest' as const },
  ];
  const events = [{ title: 'Soccer', start: '2026-10-20T16:00:00.000Z', end: '2026-10-20T17:00:00.000Z' }];

  it('a reload that dropped the calendar and the PIN reconciles the same member and invite rows', async () => {
    // Run 1 fails at the calendar import, after the members and invites are written.
    mock.db = refusing(db, (table, calls) => table === 'calendar_events' && calls.includes('upsert'));
    const first = await finalizeOnboardingAction(payload({ members: household, appearance: { pin: '1234' }, calendarImport: { source: 'demo', events } }));
    expect(first.ok).toBe(false);
    expect(db.table('family_members').filter((m) => m.display_name === 'Ava')).toHaveLength(1);
    expect(db.table('invites')).toHaveLength(1);

    // Run 2, after a reload: same household, no events, no PIN.
    mock.db = db;
    const second = await finalizeOnboardingAction(payload({ members: household }));
    expect(second.ok).toBe(true);
    expect(db.table('family_members').filter((m) => m.display_name === 'Ava')).toHaveLength(1);
    expect(db.table('invites')).toHaveLength(1);
    expect(mock.sendReactEmail.mock.calls.filter(([args]) => args.to === 'grandpa@example.test')).toHaveLength(1);
  });

  it('a different member is still a new row (control)', async () => {
    await finalizeOnboardingAction(payload({ members: [household[0]] }));
    db.table('onboarding_progress')[0].status = 'in_progress';
    await finalizeOnboardingAction(payload({ members: [household[0], { kind: 'local', name: 'Ben', role: 'child' }] }));
    expect(db.table('family_members').filter((m) => m.display_name === 'Ava')).toHaveLength(1);
    expect(db.table('family_members').filter((m) => m.display_name === 'Ben')).toHaveLength(1);
  });
});

describe('the welcome email (A17)', () => {
  const welcomes = () => mock.sendReactEmail.mock.calls.filter(([args]) => /Welcome/.test(args.subject));

  it('goes to the account\'s own address, never the one typed into the form, and profiles.email is the account\'s', async () => {
    const result = await finalizeOnboardingAction(payload({ profile: { firstName: 'Ada', lastName: '', phone: '', email: 'stranger@victim.test' } }));
    expect(result.ok).toBe(true);
    expect(welcomes().map(([args]) => args.to)).toEqual(['ada@example.test']);
    expect(mock.saveUserProfile).toHaveBeenCalledWith(USER, expect.objectContaining({ email: 'ada@example.test' }));
  });

  it('is sent once however often finish is replayed', async () => {
    await finalizeOnboardingAction(payload());
    // A client may set its own progress row back to in_progress (0454) and finish again.
    db.table('onboarding_progress')[0].status = 'in_progress';
    mock.rateAllowed = false;
    await finalizeOnboardingAction(payload());
    expect(welcomes()).toHaveLength(1);
    expect([...mock.limiterHits.keys()].filter((k) => k.includes('email:welcome:'))).toHaveLength(1);
  });
});

describe('the setup questionnaire is a manager\'s (A8)', () => {
  const details = { familyId: OWN, householdAdults: 2, householdChildren: 1, childAges: [7], goals: ['calendar'], referralSource: 'search' };

  beforeEach(() => {
    db.seed('family_onboarding', [{ family_id: OWN, household_adults: 2, household_children: 3, goals: ['budget'], completed_at: '2026-01-01T00:00:00Z' }]);
    // The owner's contact, as finalize made it.
    db.seed('crm_contacts', [{ id: 'c-owner', email: 'owner@example.test', first_name: 'Owner', family_id: OWN, owner_id: null, created_by: OTHER_USER,
      notes: JSON.stringify({ onboarding_user_id: OTHER_USER, role: 'parent' }) }]);
    db.seed('profiles', [{ id: USER, display_name: 'Kid', email: null, phone: null }]);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is refused, and the household\'s answers and the owner\'s contact are untouched', async (role) => {
    mock.ctxRole = role;
    expect(await saveFamilyDetailsAction(details)).toEqual({ ok: false, error: 'actions.onlyAParentOrGuardian' });
    expect(db.table('family_onboarding')[0]).toMatchObject({ household_children: 3, goals: ['budget'] });
    expect(db.table('crm_contacts')).toEqual([expect.objectContaining({ id: 'c-owner', email: 'owner@example.test', first_name: 'Owner' })]);
  });

  it('a family that is not the caller\'s active one is refused', async () => {
    expect((await saveFamilyDetailsAction({ ...details, familyId: '20000000-0000-4000-8000-000000000009' })).ok).toBe(false);
    expect(db.table('family_onboarding')[0]).toMatchObject({ household_children: 3 });
  });

  it('a co-parent saves the answers, and gets a contact of their own rather than the owner\'s', async () => {
    expect(await saveFamilyDetailsAction(details)).toEqual({ ok: true });
    expect(db.table('family_onboarding')[0]).toMatchObject({ household_children: 1, goals: ['calendar'] });
    const owner = db.table('crm_contacts').find((c) => c.id === 'c-owner')!;
    expect(owner).toMatchObject({ email: 'owner@example.test', first_name: 'Owner' });
    expect(db.table('crm_contacts').filter((c) => c.email === 'ada@example.test')).toHaveLength(1);
  });
});
