// A child cannot run the onboarding wizard's Finish to become a parent.
//
// `finalizeOnboardingAction` adopts an existing family when the caller's
// onboarding_progress row says the wizard is resumable (source 'wizard', not
// completed) or the space was auto-provisioned — and adopting it means, through
// the service role: rename the family, change its timezone, upsert the caller's
// membership as role 'parent', and create members and invites in it.
//
// That progress row is not an authority. Its `source` and `status` columns are
// client-writable (0454 keeps them for the calendar setup path), and
// `resetOnboardingAction` — callable by any signed-in member — writes one with
// status 'reset' and the table's default source 'wizard'. Both the wizard's
// calendar path (`prepareCalendarFamily`, `verifyCalendarWizard`) and the claim
// RPC (0454) only ever treat a family as the caller's own setup when the caller
// CREATED it and is its parent. Finish adopted any oldest membership.
//
// Driven here as the attacker would: a child in someone else's family calls
// the reset action, then Finish with a crafted payload and no owner hint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';

const mock = vi.hoisted(() => ({ db: null as unknown, saveProfile: vi.fn(), sendReactEmail: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages('en-US'), key) };
});
vi.mock('@/lib/server/profiles', () => ({ saveUserProfile: mock.saveProfile }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test', sendReactEmail: mock.sendReactEmail }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/marketing/onboarding-contact', () => ({ upsertOnboardingContact: async () => {} }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { finalizeOnboardingAction, resetOnboardingAction } = await import('@/app/onboarding/actions');

const parentUser = '10000000-0000-4000-8000-0000000000a1';
const childUser = '10000000-0000-4000-8000-0000000000c1';
const ownerUser = '10000000-0000-4000-8000-0000000000b1';
const familyId = '20000000-0000-4000-8000-0000000000f1';
const ownFamilyId = '20000000-0000-4000-8000-0000000000f2';

function database(userId: string): InMemorySupabase {
  return createInMemorySupabase({
    userId,
    uniques: {
      family_members: [['family_id', 'user_id']], user_preferences: [['user_id']], onboarding_progress: [['user_id']],
      invites: [['family_id', 'onboarding_key']], family_onboarding: [['family_id']],
    },
    // 0159: a progress row nobody named a source for is a wizard row in progress.
    defaults: { onboarding_progress: { source: 'wizard', status: 'in_progress' } },
    rpc: { onboarding_claim_family: () => [{ family_id: ownFamilyId, created: true }] },
  });
}

/** What a hostile Finish asks for: a new family name, and an adult of its choosing. */
function hostilePayload() {
  return buildFinalizePayload({
    ...emptyDraft({ name: 'Kid', familyName: 'Taken Over', timezone: 'Pacific/Kiritimati' }),
    members: [{ kind: 'invite', email: 'accomplice@example.test', role: 'adult' }],
  } as Parameters<typeof buildFinalizePayload>[0]);
}

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.saveProfile.mockReset().mockResolvedValue({ ok: true });
  mock.sendReactEmail.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Finish adopts only a family the caller created and parents', () => {
  beforeEach(() => {
    db = database(childUser);
    mock.db = db;
    db.seed('families', [{ id: familyId, created_by: parentUser, name: 'The Real Family', timezone: 'America/Chicago' }]);
    db.seed('family_members', [
      { id: 'parent-member', family_id: familyId, user_id: parentUser, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'child-member', family_id: familyId, user_id: childUser, role: 'child', is_active: true, created_at: '2026-02-01T00:00:00Z' },
    ]);
    db.seed('subscriptions', [{ id: 'sub', family_id: familyId, plan: 'plus', status: 'active' }]);
    db.seed('user_preferences', [{ user_id: childUser, active_family_id: familyId, notification_prefs: {} }]);
  });

  it('a child who resets onboarding and then finishes it stays a child, and the family is untouched', async () => {
    expect(await resetOnboardingAction()).toEqual({ ok: true });

    const result = await finalizeOnboardingAction(hostilePayload());

    const child = db.table('family_members').find((m) => m.user_id === childUser);
    expect(child?.role).toBe('child');
    expect(db.table('families')[0]).toMatchObject({ name: 'The Real Family', timezone: 'America/Chicago' });
    expect(db.table('invites')).toHaveLength(0);
    expect(db.table('family_onboarding')).toHaveLength(0);
    expect(mock.sendReactEmail).not.toHaveBeenCalled();
    // The idempotent answer every other already-onboarded member gets.
    expect(result).toEqual({ ok: true, data: { familyId } });
  });

  it('a hand-written auto_provision marker does not make someone else\'s family adoptable either', async () => {
    db.seed('onboarding_progress', [{ user_id: childUser, family_id: familyId, source: 'auto_provision', status: 'in_progress' }]);

    await finalizeOnboardingAction(hostilePayload());

    expect(db.table('family_members').find((m) => m.user_id === childUser)?.role).toBe('child');
    expect(db.table('families')[0]).toMatchObject({ name: 'The Real Family', timezone: 'America/Chicago' });
    expect(db.table('invites')).toHaveLength(0);
  });
});

describe('the owner of an auto-provisioned space still finishes the wizard into it', () => {
  it('adopts the family they created and parent, applying the name and timezone they typed', async () => {
    db = database(ownerUser);
    mock.db = db;
    db.seed('families', [{ id: ownFamilyId, created_by: ownerUser, name: 'Auto space', timezone: 'UTC' }]);
    db.seed('family_members', [
      { id: 'owner-member', family_id: ownFamilyId, user_id: ownerUser, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    ]);
    db.seed('subscriptions', [{ id: 'sub', family_id: ownFamilyId, plan: 'free', status: 'trialing' }]);
    db.seed('user_preferences', [{ user_id: ownerUser, active_family_id: ownFamilyId, notification_prefs: {} }]);
    db.seed('onboarding_progress', [{ user_id: ownerUser, family_id: ownFamilyId, source: 'auto_provision', status: 'in_progress' }]);

    const result = await finalizeOnboardingAction(buildFinalizePayload(
      emptyDraft({ name: 'Ada', familyName: 'The Lovelace Family', timezone: 'Europe/London' }),
    ));

    expect(result).toMatchObject({ ok: true, data: { familyId: ownFamilyId } });
    expect(db.table('families')[0]).toMatchObject({ name: 'The Lovelace Family', timezone: 'Europe/London' });
    expect(db.table('family_members').find((m) => m.user_id === ownerUser)?.role).toBe('parent');
    expect(db.table('onboarding_progress')[0]).toMatchObject({ source: 'wizard', status: 'completed' });
  });
});
