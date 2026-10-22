// The referral program acts only on settings it could read, and only for a
// parent or an adult.
//
//   N2  — getReferralConfig dropped a FAILED read of marketing_settings and
//         answered the defaults: enabled, $10/$10. During that read a family
//         paused by the admin (or set to $25) applied a code and got a
//         referral row carrying $10/$10 — which Stripe later pays — and the
//         invite email promised "$10 credit"; the page showed the program on.
//   N16 — the apply and invite actions checked only that the caller was signed
//         in. A guest (who may be a parent in their own household) or a child
//         could spend the family's ONE referral on a code of their choice, send
//         invites in its name, and read the invited friends' addresses and the
//         credit earned.
//
// Driven through the real actions, the real referral server module and the real
// page against an in-memory database.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', sent: [] as string[] }));
const FAMILY = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const ctx = () => ({
  user: { id: 'user-1', email: 'parent@example.invalid' },
  memberships: [],
  active: { familyId: FAMILY, role: h.role, member: { id: 'member-1', display_name: 'Pat' }, family: { id: FAMILY, name: 'Rivera', timezone: 'UTC' } },
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx(), requireFeature: async () => ctx() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => { throw new Error('No payment provider in this fixture'); } }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://example.invalid', sendReactEmail: async ({ to }: { to: string }) => { h.sent.push(to); return { ok: true }; } }));
vi.mock('@/lib/emails/referral', () => ({ ReferralEmail: () => null }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtMoney: (cents: number) => `$${(cents / 100).toFixed(2)}` }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

const { applyReferralCodeAction, sendReferralEmailAction } = await import('@/app/(app)/referrals/actions');
const { applyReferralCode } = await import('@/lib/referrals/server');
const ReferralsPage = (await import('@/app/(app)/referrals/page')).default;

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: InMemorySupabase;

/** marketing_settings answers every read with an error, the way a failed read does. */
function settingsReadFails() {
  const realFrom = db.from.bind(db);
  const reply = { data: null, error: { code: 'XX000', message: 'Synthetic settings outage' }, count: null, status: 500, statusText: 'Error' };
  const proxy: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(reply).then(resolve);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(reply);
      return () => proxy;
    },
  });
  (db as unknown as { from: (t: string) => unknown }).from = (table: string) => (table === 'marketing_settings' ? proxy : realFrom(table));
}

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { referrals: [['referred_family_id']], referral_codes: [['family_id'], ['code']] } });
  h.db = db; h.role = 'parent'; h.sent = [];
  // The admin paused the program, at $25.
  db.seed('marketing_settings', [{ key: 'referral_program', value: { enabled: false, referrerRewardCents: 2500, referredRewardCents: 2500, rewardLabel: '$25 credit' } }]);
  db.seed('referral_codes', [
    { family_id: FAMILY, code: 'RIVERA-OWN1', created_by: 'user-1' },
    { family_id: FRIEND, code: 'FRIEND-7K4Q', created_by: 'user-2' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a failed settings read is not the default program (N2)', () => {
  it('applying a code refuses, and writes no referral carrying the default $10/$10', async () => {
    settingsReadFails();
    const res = await applyReferralCode({ rawCode: 'FRIEND-7K4Q', referredFamilyId: FAMILY });
    expect(res).toMatchObject({ ok: false, code: 'lookup_failed' });
    expect(db.table('referrals')).toEqual([]);
  });

  it('the invite action refuses, and no email promising "$10 credit" goes out', async () => {
    settingsReadFails();
    const res = await sendReferralEmailAction('friend@example.invalid');
    expect(res).toEqual({ ok: false, reason: t('referralActions.couldNotRecordInvite') });
    expect(h.sent).toEqual([]);
    expect(db.table('referrals')).toEqual([]);
  });

  it('the page shows its retry section rather than an enabled program', async () => {
    settingsReadFails();
    const html = renderTranslated(await ReferralsPage());
    expect(html).toContain(t('root.somethingWentWrongLoadingThisSection'));
    expect(html).not.toContain('$10 credit');
  });

  it('a settings row that reads says paused, and is obeyed', async () => {
    const res = await applyReferralCode({ rawCode: 'FRIEND-7K4Q', referredFamilyId: FAMILY });
    expect(res).toMatchObject({ ok: false, code: 'paused' });
  });
});

describe('the family\'s referral is a parent\'s or an adult\'s (N16)', () => {
  beforeEach(() => {
    db.table('marketing_settings')[0].value = { enabled: true, referrerRewardCents: 1000, referredRewardCents: 1000, rewardLabel: '$10 credit' };
  });

  it.each(['guest', 'child', 'teen'])('a %s cannot spend the family\'s one referral', async (role) => {
    h.role = role;
    const res = await applyReferralCodeAction('FRIEND-7K4Q');
    expect(res).toMatchObject({ ok: false, reason: t('referralActions.onlyAParentOrAdult') });
    expect(db.table('referrals')).toEqual([]);
  });

  it('a parent can', async () => {
    const res = await applyReferralCodeAction('FRIEND-7K4Q');
    expect(res).toEqual({ ok: true });
    expect(db.table('referrals')).toHaveLength(1);
  });

  it('a child cannot email an invite in the family\'s name', async () => {
    h.role = 'child';
    const res = await sendReferralEmailAction('friend@example.invalid');
    expect(res).toEqual({ ok: false, reason: t('referralActions.onlyAParentOrAdult') });
    expect(h.sent).toEqual([]);
  });

  it('a guest sees the code to share, not whom the parents invited or the credit earned', async () => {
    db.seed('referrals', [{
      id: '33333333-3333-4333-8333-333333333333', code: 'RIVERA-OWN1', referrer_family_id: FAMILY, referred_family_id: null,
      referred_email: 'invited-friend@example.invalid', status: 'rewarded', source: 'email_invite', referrer_reward_cents: 1000,
      referred_reward_cents: 1000, metadata: null, created_at: '2026-10-01T00:00:00.000Z',
    }]);
    h.role = 'guest';
    const guest = renderTranslated(await ReferralsPage());
    expect(guest).toContain('RIVERA-OWN1');
    expect(guest).not.toContain('invited-friend@example.invalid');
    expect(guest).not.toContain(t('referrals.tileEarned'));
    expect(guest).not.toContain(t('referral.haveAReferralCode'));
    expect(guest).not.toContain(t('referralPanel.emailAnInvite'));

    h.role = 'parent';
    const parent = renderTranslated(await ReferralsPage());
    expect(parent).toContain('invited-friend@example.invalid');
    expect(parent).toContain(t('referrals.tileEarned'));
    expect(parent).toContain(t('referral.haveAReferralCode'));
  });
});
