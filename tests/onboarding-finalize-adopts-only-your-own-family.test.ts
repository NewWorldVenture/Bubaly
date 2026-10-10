import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';

// Three properties of finalizeOnboardingAction, run against the real action:
//
// 1. The ADOPT branch took the caller's OLDEST active membership and, if their
//    onboarding marker was an auto-provision, renamed that family and upserted
//    the caller into it as a PARENT with the service role. Nothing checked that
//    the membership was the family the marker named, or theirs. A guest of
//    someone else's household (own family deactivated) became its parent.
// 2. Every drafted invite (up to 30) mailed a caller-chosen address, with a
//    caller-chosen subject, with no limiter. Now capped at 5 and limited.
// 3. A child login removed from its family must not mint one of its own.

const mock = vi.hoisted(() => ({ db: null as unknown, sendReactEmail: vi.fn(), rateAllowed: true }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/profiles', () => ({ saveUserProfile: async () => ({ ok: true }) }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => {} }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test', sendReactEmail: mock.sendReactEmail }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/marketing/onboarding-contact', () => ({ upsertOnboardingContact: async () => {} }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { finalizeOnboardingAction } = await import('@/app/onboarding/actions');

const USER = '10000000-0000-4000-8000-000000000001';
const OWN = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const STRANGER = '10000000-0000-4000-8000-000000000009';
let db: InMemorySupabase;

function build() {
  db = createInMemorySupabase({ userId: USER, uniques: { family_members: [['family_id', 'user_id']], user_preferences: [['user_id']],
    onboarding_progress: [['user_id']], invites: [['family_id', 'onboarding_key']], calendar_events: [['family_id', 'onboarding_key']],
    onboarding_imports: [['family_id', 'onboarding_key']] },
  rpc: {
    onboarding_claim_family: () => [{ family_id: OWN, created: true }],
    rate_limit_hit: () => [{ allowed: mock.rateAllowed, retry_after: mock.rateAllowed ? 0 : 60 }],
  } });
  mock.db = db;
}

const payload = (members: ReturnType<typeof buildFinalizePayload>['members'] = []) => ({
  ...buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Takeover', timezone: 'Asia/Tokyo' })), members,
});
const invites = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'invite' as const, email: `p${i}@example.test`, role: 'adult' as const }));
const inviteMails = () => mock.sendReactEmail.mock.calls.filter(([a]) => /^p\d+@/.test((a as { to: string }).to));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.sendReactEmail.mockReset().mockResolvedValue({ ok: true });
  mock.rateAllowed = true;
  build();
});

describe('the adopt branch adopts only your own auto-provisioned family', () => {
  function seedTakeover() {
    // U was auto-provisioned OWN, joined OTHER as a guest, then deactivated
    // their own row in OWN. Their oldest ACTIVE membership is now OTHER.
    db.seed('families', [
      { id: OWN, created_by: USER, name: 'Ada family', timezone: 'UTC' },
      { id: OTHER, created_by: STRANGER, name: 'Rivera family', timezone: 'America/Chicago' },
    ]);
    db.seed('family_members', [
      { id: 'own-row', family_id: OWN, user_id: USER, role: 'parent', is_active: false, created_at: '2026-01-01' },
      { id: 'guest-row', family_id: OTHER, user_id: USER, role: 'guest', is_active: true, created_at: '2026-02-01' },
      { id: 'rivera-parent', family_id: OTHER, user_id: STRANGER, role: 'parent', is_active: true, created_at: '2025-01-01' },
    ]);
    db.seed('onboarding_progress', [{ user_id: USER, family_id: OWN, source: 'auto_provision', status: 'in_progress' }]);
  }

  it("refuses, and leaves the other household's name, zone and roster alone", async () => {
    seedTakeover();
    const result = await finalizeOnboardingAction(payload(invites(1)));
    expect(result.ok).toBe(false);
    const other = db.table('families').find((f) => f.id === OTHER)!;
    expect(other).toMatchObject({ name: 'Rivera family', timezone: 'America/Chicago' });
    expect(db.table('family_members').find((m) => m.id === 'guest-row')!.role).toBe('guest');
    expect(db.table('family_members').filter((m) => m.family_id === OTHER && m.role === 'parent')).toHaveLength(1);
    expect(db.table('invites')).toHaveLength(0);
  });

  it('still adopts the caller’s own auto-provisioned family (control)', async () => {
    db.seed('families', [{ id: OWN, created_by: USER, name: 'Ada family', timezone: 'UTC' }]);
    db.seed('family_members', [{ id: 'own-row', family_id: OWN, user_id: USER, role: 'parent', is_active: true, created_at: '2026-01-01' }]);
    db.seed('onboarding_progress', [{ user_id: USER, family_id: OWN, source: 'auto_provision', status: 'in_progress' }]);
    const result = await finalizeOnboardingAction(payload());
    expect(result).toMatchObject({ ok: true, data: { familyId: OWN } });
    expect(db.table('families')[0]).toMatchObject({ name: 'Takeover', timezone: 'Asia/Tokyo' });
  });

  it('refuses a family the caller is the parent of but did not create', async () => {
    db.seed('families', [{ id: OTHER, created_by: STRANGER, name: 'Rivera family', timezone: 'UTC' }]);
    db.seed('family_members', [{ id: 'p', family_id: OTHER, user_id: USER, role: 'parent', is_active: true, created_at: '2026-01-01' }]);
    db.seed('onboarding_progress', [{ user_id: USER, family_id: OTHER, source: 'auto_provision', status: 'in_progress' }]);
    expect((await finalizeOnboardingAction(payload())).ok).toBe(false);
    expect(db.table('families')[0].name).toBe('Rivera family');
  });
});

describe('onboarding invite emails are bounded', () => {
  function seedNewUser() {
    db.seed('families', [{ id: OWN, created_by: USER, name: 'Ada family', timezone: 'UTC' }]);
  }

  it('sends at most five invite emails however many invites are drafted', async () => {
    seedNewUser();
    const result = await finalizeOnboardingAction(payload(invites(12)));
    expect(result.ok).toBe(true);
    expect(db.table('invites')).toHaveLength(12);
    expect(inviteMails()).toHaveLength(5);
  });

  it('sends none when the limiter refuses', async () => {
    seedNewUser();
    mock.rateAllowed = false;
    const result = await finalizeOnboardingAction(payload(invites(2)));
    expect(result.ok).toBe(true);
    expect(db.table('invites')).toHaveLength(2);
    expect(inviteMails()).toHaveLength(0);
  });
});

describe('a removed child login cannot onboard a household of its own', () => {
  it('refuses the family claim for an account with a child_logins row', async () => {
    const claim = vi.fn(() => [{ family_id: OWN, created: true }]);
    db = createInMemorySupabase({ userId: USER, rpc: { onboarding_claim_family: claim } });
    db.seed('child_logins', [{ id: 'cl', user_id: USER, member_id: 'gone', family_id: OTHER, username: 'emma' }]);
    mock.db = db;
    const result = await finalizeOnboardingAction(payload());
    expect(result.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(db.table('family_members')).toHaveLength(0);
  });
});
