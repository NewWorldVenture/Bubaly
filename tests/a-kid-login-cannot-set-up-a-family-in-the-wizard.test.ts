import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';
import { getMessages, translate } from '@/lib/i18n/messages';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';

/**
 * A kid login cannot set up a family of its own in the onboarding wizard.
 *
 * A kid login (username + PIN, on the synthetic kids address) is a member of the
 * family whose parent made it. When it has no active family — the parent
 * removed the child — `requireUserContext` now sends it to the kid sign-in
 * rather than provisioning a family. But `/onboarding` is reachable by URL, and
 * both of its family-creating actions took any signed-in account:
 *
 *  - `finalizeOnboardingAction` claimed a family (`onboarding_claim_family`)
 *    with the kid login as its PARENT, plus a trial;
 *  - `startCalendarConnectionAction` claimed one the same way before handing
 *    off to the calendar provider.
 *
 * Both now refuse a kid login before anything is written.
 */

const mock = vi.hoisted(() => ({ db: null as unknown, saveProfile: vi.fn(), email: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn(), get: () => undefined }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(), getUserContext: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages('en-US'), key) };
});
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ provider: 'google', isConfigured: () => true }), configuredAdapters: () => [] }));
vi.mock('@/lib/server/profiles', () => ({ saveUserProfile: mock.saveProfile }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/server/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test', sendReactEmail: vi.fn() }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/marketing/onboarding-contact', () => ({ upsertOnboardingContact: async () => {} }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { finalizeOnboardingAction } = await import('@/app/onboarding/actions');
const { startCalendarConnectionAction } = await import('@/app/onboarding/calendar-actions');

const KID = '30000000-0000-4000-8000-000000000003';
const NEW_FAMILY = '40000000-0000-4000-8000-000000000004';
const REFUSED = translate(getMessages('en-US'), 'onboardingWizard.aKidLoginCannotSetUpAFamily');
let db: InMemorySupabase;
let claims: string[];

beforeEach(() => {
  vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32));
  vi.stubEnv('GOOGLE_SYNC_CLIENT_ID', 'configured-client');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.saveProfile.mockReset().mockResolvedValue({ ok: true });
  mock.email = syntheticChildEmail('emma');
  claims = [];
  db = createInMemorySupabase({
    userId: KID,
    uniques: { family_members: [['family_id', 'user_id']], user_preferences: [['user_id']], onboarding_progress: [['user_id']] },
    rpc: {
      // What 0210's claim does: a new family, created by the caller, with a wizard marker.
      onboarding_claim_family: (args, fixture) => {
        claims.push(String(args.p_user_id));
        fixture.seed('families', [{ id: NEW_FAMILY, created_by: args.p_user_id, name: args.p_name, timezone: args.p_timezone }]);
        fixture.seed('onboarding_progress', [{ user_id: args.p_user_id, family_id: NEW_FAMILY, source: 'wizard', status: 'in_progress', updated_at: '2026-10-10T00:00:00Z' }]);
        return [{ family_id: NEW_FAMILY, created: true }];
      },
    },
  });
  vi.spyOn(db.auth, 'getUser').mockImplementation(async () => ({ data: { user: { id: KID, email: mock.email } }, error: null }) as never);
  mock.db = db;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const finish = () => finalizeOnboardingAction(
  buildFinalizePayload(emptyDraft({ name: 'Emma', familyName: 'Emma family', timezone: 'UTC' })),
  { userId: KID, familyId: null },
);
const connect = () => startCalendarConnectionAction(
  { provider: 'google', family: { name: 'Emma family', timezone: 'UTC' }, displayName: 'Emma' },
  { expectedOwner: { userId: KID, familyId: null } },
);

describe('a kid login in the onboarding wizard', () => {
  it('cannot finish the wizard into a family of its own', async () => {
    expect(await finish()).toEqual({ ok: false, error: REFUSED });
    expect(claims).toEqual([]);
    expect(mock.saveProfile).not.toHaveBeenCalled();
    expect(db.table('family_members')).toEqual([]);
  });

  it('cannot claim a family by connecting a calendar', async () => {
    expect(await connect()).toEqual({ ok: false, error: REFUSED });
    expect(claims).toEqual([]);
    expect(db.table('family_members')).toEqual([]);
  });

  it('is recognised in any letter case', async () => {
    mock.email = syntheticChildEmail('emma').toUpperCase();
    expect(await finish()).toEqual({ ok: false, error: REFUSED });
    expect(claims).toEqual([]);
  });
});

describe('a grown-up in the same wizard (control)', () => {
  it('reaches the family claim when finishing', async () => {
    mock.email = 'emma.parent@example.test';
    await finish();
    expect(claims).toEqual([KID]);
    expect(mock.saveProfile).toHaveBeenCalled();
  });

  it('reaches the family claim when connecting a calendar', async () => {
    mock.email = 'emma.parent@example.test';
    await connect();
    expect(claims).toEqual([KID]);
  });
});

describe('the refusal is said in every base language', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s', (locale) => {
    const message = getMessages(locale)['onboardingWizard.aKidLoginCannotSetUpAFamily'];
    expect(message).toBeTruthy();
    if (locale !== 'en-US') expect(message).not.toBe(getMessages('en-US')['onboardingWizard.aKidLoginCannotSetUpAFamily']);
  });
});
