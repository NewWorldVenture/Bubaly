// Call-level role tests for app/onboarding/actions.ts (audit Register B, group 8).
//
// Every exported action is driven for real against the in-memory PostgREST
// fake, with two households seeded: A (the caller's) and B (another family).
// Each case says what the action returned AND reads the tables back.
//
// The policy each case pins, and where it comes from:
//  - saveFamilyDetailsAction: the household questionnaire is a manager's
//    (isManager, lib/constants/roles.ts:56; the action's own comment; the
//    /dashboard/setup page shows the form only when isManager). The family is
//    the caller's ACTIVE one; any other familyId is refused.
//  - resetOnboardingAction: account-scoped. The /dashboard/setup page offers
//    the Reset control only inside the manager form; the action checks no
//    role and writes only the caller's own rows. A non-manager calling it is
//    an owner decision (see the PR body), so only parent, adult, the
//    signed-out caller and the cross-family pointer are pinned here.
//  - previewCalendarImportAction: signed-in only, writes nothing, reads no
//    membership, so every role gets the same preview.
//  - finalizeOnboardingAction: a signed-in person with no household creates
//    one; a member of an existing household gets that household back
//    untouched, whatever their role; only an auto-provisioned family the
//    caller is the PARENT and creator of is adopted; a resumed claim on a
//    family the caller did not create (household B) is refused.
//
// Household size (household_adults / household_children) is deliberately not
// asserted: open PR #1173 changes what a skipped About step records.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

const mock = vi.hoisted(() => ({
  db: null as unknown,
  caller: null as null | { id: string; email: string },
  ctx: null as unknown,
  epoch: 0,
  upsertOnboardingContact: vi.fn(),
  fireAutomationEvent: vi.fn(),
  logAudit: vi.fn(),
  sendReactEmail: vi.fn(),
}));

vi.mock('@/lib/server/rate-limit', async (original) => {
  const real = await original<typeof import('@/lib/server/rate-limit')>();
  return { ...real, rateLimit: (key: string, opts?: Parameters<typeof real.rateLimit>[1]) => real.rateLimit(`${mock.epoch}:${key}`, opts) };
});
// The caller's client answers auth.getUser() with the signed-in account (or
// none); its tables are the same in-memory database the service client uses.
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => {
    const db = mock.db as InMemorySupabase;
    return {
      from: (table: string) => db.from(table),
      rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args),
      auth: { getUser: async () => ({ data: { user: mock.caller }, error: null }) },
    };
  },
  createServiceClient: () => mock.db,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!mock.ctx) throw new Error('NEXT_REDIRECT /login');
    return mock.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: mock.logAudit }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.example.com', sendReactEmail: mock.sendReactEmail }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: mock.fireAutomationEvent }));
vi.mock('@/lib/marketing/onboarding-contact', () => ({ upsertOnboardingContact: mock.upsertOnboardingContact }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { finalizeOnboardingAction, previewCalendarImportAction, resetOnboardingAction, saveFamilyDetailsAction } =
  await import('@/app/onboarding/actions');

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const NEWCOMER = 'c0000000-0000-4000-8000-0000000000c1';
const NEW_FAMILY = 'c0000000-0000-4000-8000-0000000000f1';
const B_PARENT = 'b0000000-0000-4000-8000-0000000000b1';
const ROLES: Role[] = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'];
const userOf = (role: Role) => `a0000000-0000-4000-8000-0000000001${String(ROLES.indexOf(role)).padStart(2, '0')}`;
const memberOf = (role: Role) => `a0000000-0000-4000-8000-0000000002${String(ROLES.indexOf(role)).padStart(2, '0')}`;

let db: InMemorySupabase;
let claim: ReturnType<typeof vi.fn<(args?: Record<string, unknown>) => Array<{ family_id: string; created: boolean }>>>;

function build() {
  claim = vi.fn((_args?: Record<string, unknown>) => {
    db.table('families').push(db.withDefaults('families', { id: NEW_FAMILY, created_by: NEWCOMER, name: 'Provisioned', timezone: 'UTC' }));
    return [{ family_id: NEW_FAMILY, created: true }];
  });
  db = createInMemorySupabase({
    uniques: {
      family_members: [['family_id', 'user_id']], user_preferences: [['user_id']], onboarding_progress: [['user_id']],
      family_onboarding: [['family_id']], invites: [['family_id', 'onboarding_key']],
      calendar_events: [['family_id', 'onboarding_key']], onboarding_imports: [['family_id', 'onboarding_key']], profiles: [['id']],
    },
    rpc: {
      onboarding_claim_family: (args) => claim(args),
      rate_limit_hit: () => [{ allowed: true, retry_after: 0 }],
    },
  });
  mock.db = db;
  db.seed('families', [
    { id: FAMILY_A, created_by: userOf('parent'), name: 'Household A', timezone: 'America/Chicago' },
    { id: FAMILY_B, created_by: B_PARENT, name: 'Household B', timezone: 'Europe/Paris' },
  ]);
  db.seed('family_members', [
    ...ROLES.map((role, i) => ({
      id: memberOf(role), family_id: FAMILY_A, user_id: userOf(role), role, is_active: true,
      display_name: role, created_at: `2026-01-0${i + 1}T00:00:00Z`,
    })),
    { id: 'b0000000-0000-4000-8000-0000000002b1', family_id: FAMILY_B, user_id: B_PARENT, role: 'parent', is_active: true, created_at: '2025-06-01T00:00:00Z' },
  ]);
  db.seed('family_onboarding', [{ family_id: FAMILY_B, goals: ['meals'], referral_source: 'podcast', created_by: B_PARENT, completed_at: '2026-02-01T00:00:00Z' }]);
  db.seed('subscriptions', [
    { family_id: FAMILY_A, plan: 'family', status: 'active' },
    { family_id: FAMILY_B, plan: 'family', status: 'active' },
  ]);
}

function signIn(userId: string | null) {
  mock.caller = userId ? { id: userId, email: `${userId.slice(-4)}@example.com` } : null;
}
function signInAsMemberOfA(role: Role) {
  signIn(userOf(role));
  mock.ctx = {
    user: { id: userOf(role), email: `${role}@example.com` }, memberships: [],
    active: { familyId: FAMILY_A, role, member: { id: memberOf(role) }, family: { id: FAMILY_A, name: 'Household A' } },
  };
}

/** A deep copy of every table, to prove a refused call wrote nothing. */
const snapshot = (...tables: string[]) => JSON.parse(JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.table(t)]))));
/**
 * The same, with the caller's own display name masked. finalize saves the
 * caller's profile (saveUserProfile, which also syncs their own
 * family_members.display_name) BEFORE it resolves the family, so every path —
 * the refused ones included — renames the caller's own membership rows. Whether
 * a refused finalize may do that is an owner decision (PR body); it is neither
 * pinned nor forbidden here. Every other column of every row is compared.
 */
const snapshotOwnNameMasked = (userId: string, ...tables: string[]) => {
  const copy = snapshot(...tables);
  for (const row of copy.family_members ?? []) if (row.user_id === userId) row.display_name = '<own display name>';
  delete copy.profiles;
  return copy;
};
const HOUSEHOLD_TABLES = ['families', 'family_members', 'family_onboarding', 'subscriptions', 'invites', 'user_preferences', 'onboarding_progress', 'profiles'];
const onboardingRow = (familyId: string) => db.table('family_onboarding').find((r) => r.family_id === familyId);

const details = (familyId: string) => ({
  familyId, householdAdults: 2, householdChildren: 1, childAges: [7],
  goals: ['chores', 'not-a-goal', 'meals'], referralSource: 'podcast', referralDetail: 'A show',
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mock.upsertOnboardingContact.mockReset().mockResolvedValue(undefined);
  mock.fireAutomationEvent.mockReset().mockResolvedValue(undefined);
  mock.logAudit.mockReset().mockResolvedValue(undefined);
  mock.sendReactEmail.mockReset().mockResolvedValue({ ok: true });
  mock.epoch++;
  mock.ctx = null;
  mock.caller = null;
  build();
});

describe('saveFamilyDetailsAction answers each role of household A', () => {
  it.each(['parent', 'adult'] as const)('ACTION-2C0D1DC16D66 a %s saves the questionnaire for household A and nothing else', async (role) => {
    signInAsMemberOfA(role);
    const before = snapshot('family_onboarding');
    await expect(saveFamilyDetailsAction(details(FAMILY_A))).resolves.toEqual({ ok: true });

    expect(onboardingRow(FAMILY_A)).toMatchObject({
      family_id: FAMILY_A, goals: ['chores', 'meals'], referral_source: 'podcast', referral_detail: 'A show', created_by: userOf(role),
    });
    expect(typeof onboardingRow(FAMILY_A)?.completed_at).toBe('string');
    // B's row is exactly as it was.
    expect(onboardingRow(FAMILY_B)).toEqual(before.family_onboarding.find((r: Row) => r.family_id === FAMILY_B));
    expect(db.table('family_onboarding')).toHaveLength(2);
    // The CRM contact is the caller's, recorded with the caller's own role.
    expect(mock.upsertOnboardingContact).toHaveBeenCalledTimes(1);
    expect(mock.upsertOnboardingContact.mock.calls[0][1]).toMatchObject({ userId: userOf(role), familyId: FAMILY_A, attributes: { role } });
    expect(mock.logAudit.mock.calls[0][1]).toMatchObject({ familyId: FAMILY_A, actorId: userOf(role), resource: 'family_onboarding' });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-2C0D1DC16D66 a %s is refused and writes nothing', async (role) => {
    signInAsMemberOfA(role);
    const before = snapshot(...HOUSEHOLD_TABLES);
    await expect(saveFamilyDetailsAction(details(FAMILY_A))).resolves.toEqual({ ok: false, error: 'actions.onlyAParentOrGuardian' });
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
    expect(onboardingRow(FAMILY_A)).toBeUndefined();
    expect(mock.upsertOnboardingContact).not.toHaveBeenCalled();
    expect(mock.fireAutomationEvent).not.toHaveBeenCalled();
    expect(mock.logAudit).not.toHaveBeenCalled();
  });

  it('ACTION-2C0D1DC16D66 a signed-out caller is sent to sign in and nothing is written', async () => {
    signIn(null);
    const before = snapshot(...HOUSEHOLD_TABLES);
    await expect(saveFamilyDetailsAction(details(FAMILY_A))).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
    expect(mock.upsertOnboardingContact).not.toHaveBeenCalled();
  });

  it("ACTION-2C0D1DC16D66 a parent of A naming household B is refused, and neither household's answers change", async () => {
    signInAsMemberOfA('parent');
    const before = snapshot(...HOUSEHOLD_TABLES);
    await expect(saveFamilyDetailsAction(details(FAMILY_B))).resolves.toEqual({ ok: false, error: 'onboardingWizard.contextChanged' });
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
    expect(onboardingRow(FAMILY_B)).toMatchObject({ goals: ['meals'], created_by: B_PARENT });
    expect(onboardingRow(FAMILY_A)).toBeUndefined();
    expect(mock.upsertOnboardingContact).not.toHaveBeenCalled();
  });
});

describe('resetOnboardingAction re-opens setup for the caller only', () => {
  function seedOwnPreferences(userId: string, activeFamilyId: string) {
    db.seed('user_preferences', [{ user_id: userId, active_family_id: activeFamilyId, notification_prefs: { onboardingComplete: true, appLock: { kept: true } }, updated_at: '2026-03-01T00:00:00Z' }]);
    db.seed('user_preferences', [{ user_id: B_PARENT, active_family_id: FAMILY_B, notification_prefs: { onboardingComplete: true }, updated_at: '2026-03-01T00:00:00Z' }]);
    db.seed('onboarding_progress', [{ user_id: B_PARENT, family_id: FAMILY_B, source: 'wizard', status: 'completed' }]);
  }

  it.each(['parent', 'adult'] as const)('ACTION-7FE88226F6DE a %s of A resets their own setup, naming household A', async (role) => {
    seedOwnPreferences(userOf(role), FAMILY_A);
    signIn(userOf(role));
    const bBefore = snapshot('families', 'family_members', 'family_onboarding');
    await expect(resetOnboardingAction()).resolves.toEqual({ ok: true });

    const own = db.table('user_preferences').find((r) => r.user_id === userOf(role));
    expect(own?.notification_prefs).toEqual({ onboardingComplete: false, appLock: { kept: true } });
    expect(db.table('onboarding_progress').find((r) => r.user_id === userOf(role))).toMatchObject({ family_id: FAMILY_A, status: 'reset' });
    // The other family's account and household are untouched.
    expect(db.table('user_preferences').find((r) => r.user_id === B_PARENT)?.notification_prefs).toEqual({ onboardingComplete: true });
    expect(db.table('onboarding_progress').find((r) => r.user_id === B_PARENT)).toMatchObject({ family_id: FAMILY_B, status: 'completed' });
    expect(snapshot('families', 'family_members', 'family_onboarding')).toEqual(bBefore);
    expect(mock.logAudit.mock.calls[0][1]).toMatchObject({ familyId: FAMILY_A, actorId: userOf(role), resource: 'onboarding_progress' });
  });

  it('ACTION-7FE88226F6DE a signed-out caller is refused and writes nothing', async () => {
    seedOwnPreferences(userOf('parent'), FAMILY_A);
    signIn(null);
    const before = snapshot(...HOUSEHOLD_TABLES);
    await expect(resetOnboardingAction()).resolves.toEqual({ ok: false, error: 'actions.notSignedIn' });
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
    expect(mock.logAudit).not.toHaveBeenCalled();
  });

  it('ACTION-7FE88226F6DE an active-family pointer naming household B is not recorded as the reset family', async () => {
    // The parent of A points their own preference row at B, a family they are
    // not a member of. The reset records no family rather than B.
    seedOwnPreferences(userOf('parent'), FAMILY_B);
    signIn(userOf('parent'));
    const bBefore = snapshot('families', 'family_members', 'family_onboarding');
    await expect(resetOnboardingAction()).resolves.toEqual({ ok: true });
    expect(db.table('onboarding_progress').find((r) => r.user_id === userOf('parent'))).toMatchObject({ family_id: null, status: 'reset' });
    expect(mock.logAudit.mock.calls[0][1]).toMatchObject({ familyId: null, actorId: userOf('parent') });
    expect(db.table('onboarding_progress').find((r) => r.user_id === B_PARENT)).toMatchObject({ family_id: FAMILY_B, status: 'completed' });
    expect(snapshot('families', 'family_members', 'family_onboarding')).toEqual(bBefore);
  });
});

describe('previewCalendarImportAction is a signed-in preview that writes nothing', () => {
  const callers: Array<[string, string]> = [...ROLES.map((role) => [`a ${role} of A`, userOf(role)] as [string, string]), ['a person with no household', NEWCOMER]];

  it.each(callers)('ACTION-478E5E023D7F %s gets the demo brief and nothing is written', async (_label, userId) => {
    signIn(userId);
    const before = snapshot(...HOUSEHOLD_TABLES);
    const result = await previewCalendarImportAction({ source: 'demo', timezone: 'America/Chicago' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.source).toBe('demo');
    expect(result.ok && result.data?.events.length).toBeGreaterThan(0);
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
  });

  it('ACTION-478E5E023D7F a signed-out caller is refused before anything is parsed', async () => {
    signIn(null);
    await expect(previewCalendarImportAction({ source: 'demo', timezone: 'UTC' })).resolves.toEqual({ ok: false, error: 'actions.notSignedIn' });
  });
});

describe('finalizeOnboardingAction answers each kind of caller', () => {
  const payload = (familyName = 'Newcomer family') => buildFinalizePayload(emptyDraft({ name: 'Ada', familyName, timezone: 'Asia/Tokyo' }));

  it('ACTION-03BB5F5C118E a signed-in person with no household creates one, as its parent', async () => {
    signIn(NEWCOMER);
    const result = await finalizeOnboardingAction(payload());
    expect(result).toMatchObject({ ok: true, data: { familyId: NEW_FAMILY } });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(db.table('family_members').filter((m) => m.family_id === NEW_FAMILY))
      .toEqual([expect.objectContaining({ user_id: NEWCOMER, role: 'parent', is_active: true })]);
    expect(db.table('subscriptions').filter((s) => s.family_id === NEW_FAMILY)).toEqual([expect.objectContaining({ plan: 'free', status: 'trialing' })]);
    expect(db.table('user_preferences').find((p) => p.user_id === NEWCOMER)).toMatchObject({ active_family_id: NEW_FAMILY });
    expect(onboardingRow(NEW_FAMILY)).toMatchObject({ created_by: NEWCOMER });
    // Neither seeded household was touched.
    expect(db.table('family_members').filter((m) => m.user_id === NEWCOMER)).toHaveLength(1);
    expect(db.table('families').find((f) => f.id === FAMILY_A)).toMatchObject({ name: 'Household A', timezone: 'America/Chicago' });
    expect(db.table('families').find((f) => f.id === FAMILY_B)).toMatchObject({ name: 'Household B', timezone: 'Europe/Paris' });
  });

  it('ACTION-03BB5F5C118E a signed-out caller is refused and nothing is written', async () => {
    signIn(null);
    const before = snapshot(...HOUSEHOLD_TABLES);
    await expect(finalizeOnboardingAction(payload())).resolves.toEqual({ ok: false, error: 'actions.notSignedIn' });
    expect(snapshot(...HOUSEHOLD_TABLES)).toEqual(before);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(ROLES)('ACTION-03BB5F5C118E a %s of A gets household A back untouched, and no second family', async (role) => {
    signIn(userOf(role));
    const tables = ['families', 'family_members', 'family_onboarding', 'subscriptions', 'invites', 'user_preferences'];
    const before = snapshotOwnNameMasked(userOf(role), ...tables);
    const result = await finalizeOnboardingAction(payload('Renamed by a replay'));
    expect(result).toEqual({ ok: true, data: { familyId: FAMILY_A } });
    expect(snapshotOwnNameMasked(userOf(role), ...tables)).toEqual(before);
    expect(claim).not.toHaveBeenCalled();
    expect(mock.sendReactEmail).not.toHaveBeenCalled();
  });

  it.each(['adult', 'teen', 'child', 'caregiver', 'guest'] as const)(
    'ACTION-03BB5F5C118E a %s of A whose marker calls A auto-provisioned cannot adopt (rename) it', async (role) => {
      // Even when the marker names A and the caller is recorded as its creator,
      // adoption needs the caller to be A's parent.
      db.table('families').find((f) => f.id === FAMILY_A)!.created_by = userOf(role);
      db.seed('onboarding_progress', [{ user_id: userOf(role), family_id: FAMILY_A, source: 'auto_provision', status: 'in_progress' }]);
      signIn(userOf(role));
      const tables = ['families', 'family_members', 'family_onboarding', 'subscriptions', 'invites'];
      const before = snapshotOwnNameMasked(userOf(role), ...tables);
      await expect(finalizeOnboardingAction(payload('Renamed by a non-parent'))).resolves.toEqual({ ok: false, error: 'onboardingWizard.contextChanged' });
      expect(snapshotOwnNameMasked(userOf(role), ...tables)).toEqual(before);
      expect(db.table('families').find((f) => f.id === FAMILY_A)).toMatchObject({ name: 'Household A', timezone: 'America/Chicago' });
    });

  it('ACTION-03BB5F5C118E the parent and creator of an auto-provisioned A adopts it (control)', async () => {
    db.seed('onboarding_progress', [{ user_id: userOf('parent'), family_id: FAMILY_A, source: 'auto_provision', status: 'in_progress' }]);
    signIn(userOf('parent'));
    const result = await finalizeOnboardingAction(payload('Adopted name'));
    expect(result).toMatchObject({ ok: true, data: { familyId: FAMILY_A } });
    expect(db.table('families').find((f) => f.id === FAMILY_A)).toMatchObject({ name: 'Adopted name', timezone: 'Asia/Tokyo' });
    expect(db.table('families').find((f) => f.id === FAMILY_B)).toMatchObject({ name: 'Household B', timezone: 'Europe/Paris' });
  });

  it('ACTION-03BB5F5C118E a resumed claim on household B, which the caller did not create, is refused', async () => {
    // A fresh account whose own onboarding marker names B: the claim resumes B.
    claim.mockImplementation(() => [{ family_id: FAMILY_B, created: false }]);
    signIn(NEWCOMER);
    const before = snapshotOwnNameMasked(NEWCOMER, ...HOUSEHOLD_TABLES);
    await expect(finalizeOnboardingAction(payload())).resolves.toEqual({ ok: false, error: 'onboardingWizard.contextChanged' });
    expect(snapshotOwnNameMasked(NEWCOMER, ...HOUSEHOLD_TABLES)).toEqual(before);
    expect(db.table('families').find((f) => f.id === FAMILY_B)).toMatchObject({ name: 'Household B', created_by: B_PARENT });
    expect(db.table('family_members').filter((m) => m.user_id === NEWCOMER)).toEqual([]);
  });

  it('ACTION-03BB5F5C118E a removed kid login cannot mint a household of its own', async () => {
    db.table('family_members').find((m) => m.id === memberOf('child'))!.is_active = false;
    db.seed('child_logins', [{ user_id: userOf('child'), member_id: memberOf('child'), family_id: FAMILY_A, username: 'kidfixture' }]);
    signIn(userOf('child'));
    const before = snapshotOwnNameMasked(userOf('child'), 'families', 'family_members', 'subscriptions');
    await expect(finalizeOnboardingAction(payload())).resolves.toEqual({ ok: false, error: 'onboardingWizard.contextChanged' });
    expect(claim).not.toHaveBeenCalled();
    expect(snapshotOwnNameMasked(userOf('child'), 'families', 'family_members', 'subscriptions')).toEqual(before);
    expect(db.table('family_members').filter((m) => m.user_id === userOf('child') && m.role === 'parent')).toEqual([]);
  });
});
