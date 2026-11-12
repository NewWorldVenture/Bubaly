// The three referral actions, called the way the panel and the Home card call
// them, by every role of household A, with household B as the other family.
//
// THE POLICY, from the sources rather than from the actions:
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - app/(app)/referrals/page.tsx computes `manager = isManager(role)` and the
//     panel (components/referrals/referral-panel.tsx) shows the apply-a-code and
//     email-a-friend controls only when `canManage`.
//   - applyReferralCodeAction's own comment: a family has ONE referral, spent
//     irreversibly; only a parent or adult may spend it. sendReferralEmailAction:
//     an invite goes out in the family's name and spends its daily allowance.
//   - lib/constants/feature-catalog.ts: 'refer-a-friend' is a free feature, so
//     no plan gate applies.
//   - The Home card (app/(app)/home/page.tsx, M39) is a per-user preference on
//     the caller's own `user_preferences` row, whose live policy is own-row for
//     every role (0321_family_erasure_indexes.sql, prefs_all: user_id = auth.uid()).
//
// The real actions, the real lib/referrals/server and the real preference merge
// run against the in-memory database; only the mail transport is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  sent: [] as string[],
  revalidated: [] as string[],
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!h.ctx) throw new Error('NEXT_REDIRECT:/login');
    return h.ctx;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { h.revalidated.push(path); } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://app.example.com',
  sendReactEmail: async ({ to }: { to: string }) => { h.sent.push(to); return { ok: true }; },
}));
vi.mock('@/lib/emails/referral', () => ({ ReferralEmail: () => null }));

const { applyReferralCodeAction, sendReferralEmailAction, dismissReferralHomeCardAction } =
  await import('@/app/(app)/referrals/actions');

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const FAMILY_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const CODE_A = 'ALDER-A1B2';
const CODE_B = 'BIRCH-B3C4';
const CODE_C = 'CEDAR-C5D6';
const DISMISSED_KEY = 'referralHomeCardDismissedAt';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
const MANAGERS = ['parent', 'adult'] as const;
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;

function signInAs(role: Role, opts: { kidLogin?: boolean; family?: string } = {}) {
  const family = opts.family ?? FAMILY_A;
  const handle = `${family.slice(0, 2)}-${role}`;
  h.ctx = {
    user: { id: `user-${handle}`, email: opts.kidLogin ? `${handle}@kids.bubaly.app` : `${handle}@example.com` },
    memberships: [],
    active: {
      familyId: family, role,
      member: { id: `member-${handle}`, display_name: `Fixture ${role}` },
      family: { id: family, name: family === FAMILY_A ? 'Alder' : 'Birch', timezone: 'UTC' },
    },
  };
}

let db: InMemorySupabase;

/** Everything any of the three actions could write, in every household. */
const everything = () => structuredClone({
  referrals: db.table('referrals'),
  codes: db.table('referral_codes'),
  prefs: db.table('user_preferences'),
});

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { referrals: [['referred_family_id']], referral_codes: [['family_id'], ['code']], user_preferences: [['user_id']] } });
  h.db = db; h.sent = []; h.revalidated = []; h.ctx = null;
  db.seed('marketing_settings', [{ key: 'referral_program', value: { enabled: true, referrerRewardCents: 1000, referredRewardCents: 1000, rewardLabel: '$10 credit' } }]);
  db.seed('referral_codes', [
    { family_id: FAMILY_A, code: CODE_A, created_by: 'user-0a-parent' },
    { family_id: FAMILY_B, code: CODE_B, created_by: 'user-0b-parent' },
    { family_id: FAMILY_C, code: CODE_C, created_by: 'user-0c-parent' },
  ]);
  // Household B was already referred by C, and its parent has dismissed the card.
  db.seed('referrals', [{
    id: 'b0000000-0000-4000-8000-000000000001', code: CODE_C, referrer_family_id: FAMILY_C, referred_family_id: FAMILY_B,
    referred_email: 'b-parent@example.com', status: 'signed_up', source: 'apply_code', metadata: null,
  }]);
  db.seed('user_preferences', [{ user_id: 'user-0b-parent', notification_prefs: { [DISMISSED_KEY]: '2026-01-01T00:00:00.000Z', digest: 'weekly' } }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('applyReferralCodeAction', () => {
  it.each(MANAGERS)('ACTION-0AD9C8014208 a %s of A spends the family referral on B\'s code, and exactly one row is written', async (role) => {
    signInAs(role);
    expect(await applyReferralCodeAction(CODE_B)).toEqual({ ok: true });
    const mine = db.table('referrals').filter((r) => r.referred_family_id === FAMILY_A);
    expect(mine).toEqual([expect.objectContaining({
      code: CODE_B, referrer_family_id: FAMILY_B, referred_family_id: FAMILY_A,
      referred_email: `0a-${role}@example.com`, status: 'signed_up', source: 'apply_code',
      referrer_reward_cents: 1000, referred_reward_cents: 1000,
    })]);
    expect(db.table('referrals')).toHaveLength(2);
    expect(h.revalidated).toEqual(['/referrals']);
  });

  it.each(NON_MANAGERS)('ACTION-0AD9C8014208 a %s of A is refused and the family referral is not spent', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await applyReferralCodeAction(CODE_B)).toEqual({ ok: false, reason: 'referralActions.onlyAParentOrAdult', code: 'denied' });
    expect(everything()).toEqual(before);
    expect(h.revalidated).toEqual([]);
  });

  it('ACTION-0AD9C8014208 a child on a kid login is refused the same way', async () => {
    signInAs('child', { kidLogin: true });
    const before = everything();
    expect(await applyReferralCodeAction(CODE_B)).toEqual({ ok: false, reason: 'referralActions.onlyAParentOrAdult', code: 'denied' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-0AD9C8014208 a signed-out caller is stopped before anything is read or written', async () => {
    const before = everything();
    await expect(applyReferralCodeAction(CODE_B)).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });

  it('ACTION-0AD9C8014208 the referral is written for the caller\'s family only, never for B, and B\'s row is untouched', async () => {
    signInAs('parent');
    const bBefore = structuredClone(db.table('referrals').filter((r) => r.referred_family_id === FAMILY_B));
    expect(await applyReferralCodeAction(CODE_C)).toEqual({ ok: true });
    expect(db.table('referrals').filter((r) => r.referred_family_id === FAMILY_B)).toEqual(bBefore);
    expect(db.table('referrals').filter((r) => r.referred_family_id === FAMILY_A)).toEqual([
      expect.objectContaining({ referrer_family_id: FAMILY_C, code: CODE_C }),
    ]);
  });

  it('ACTION-0AD9C8014208 a parent cannot spend A\'s referral on A\'s own code', async () => {
    signInAs('parent');
    const before = everything();
    expect(await applyReferralCodeAction(CODE_A)).toEqual({ ok: false, reason: 'referralActions.cannotUseYourOwnCode', code: 'own_code' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-0AD9C8014208 a parent of B, already referred, cannot spend a second referral', async () => {
    signInAs('parent', { family: FAMILY_B });
    const before = everything();
    expect(await applyReferralCodeAction(CODE_A)).toEqual({ ok: false, reason: 'referralActions.familyAlreadyUsedACode', code: 'already_referred' });
    expect(everything()).toEqual(before);
  });
});

describe('sendReferralEmailAction', () => {
  it.each(MANAGERS)('ACTION-FA5FF91E21B6 a %s of A emails a friend A\'s own code, and one pending invite is recorded for A', async (role) => {
    signInAs(role);
    expect(await sendReferralEmailAction('Friend@Example.com')).toEqual({ ok: true, email: 'friend@example.com' });
    expect(h.sent).toEqual(['friend@example.com']);
    const invites = db.table('referrals').filter((r) => r.referrer_family_id === FAMILY_A);
    expect(invites).toEqual([expect.objectContaining({
      code: CODE_A, referred_family_id: null, referred_email: 'friend@example.com', status: 'pending',
    })]);
    expect((invites[0].metadata as { email_sent_at: string[] }).email_sent_at).toHaveLength(1);
    expect(h.revalidated).toEqual(['/referrals']);
  });

  it.each(NON_MANAGERS)('ACTION-FA5FF91E21B6 a %s of A is refused, nothing is recorded and no mail goes out', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await sendReferralEmailAction('friend@example.com')).toEqual({ ok: false, reason: 'referralActions.onlyAParentOrAdult' });
    expect(everything()).toEqual(before);
    expect(h.sent).toEqual([]);
    expect(h.revalidated).toEqual([]);
  });

  it('ACTION-FA5FF91E21B6 a child on a kid login is refused the same way', async () => {
    signInAs('child', { kidLogin: true });
    const before = everything();
    expect(await sendReferralEmailAction('friend@example.com')).toEqual({ ok: false, reason: 'referralActions.onlyAParentOrAdult' });
    expect(everything()).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  it('ACTION-FA5FF91E21B6 a signed-out caller sends nothing', async () => {
    const before = everything();
    await expect(sendReferralEmailAction('friend@example.com')).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  it('ACTION-FA5FF91E21B6 an invite to B\'s parent is recorded under A only, with A\'s code, and B\'s rows are untouched', async () => {
    signInAs('parent');
    const bBefore = structuredClone(db.table('referrals'));
    expect(await sendReferralEmailAction('b-parent@example.com')).toEqual({ ok: true, email: 'b-parent@example.com' });
    expect(db.table('referrals').slice(0, 1)).toEqual(bBefore);
    expect(db.table('referrals').slice(1)).toEqual([expect.objectContaining({ referrer_family_id: FAMILY_A, code: CODE_A, status: 'pending' })]);
    expect(db.table('referral_codes')).toHaveLength(3);
  });
});

describe('dismissReferralHomeCardAction', () => {
  // A per-user preference on the caller's own row: every role may write it
  // (prefs_all, 0321), and it changes nothing for anyone else.
  it.each([...MANAGERS, ...NON_MANAGERS])('ACTION-4FDB462605BB a %s of A dismisses the card on their own preferences row only', async (role) => {
    signInAs(role);
    const others = structuredClone(db.table('user_preferences'));
    expect(await dismissReferralHomeCardAction()).toEqual({ ok: true });
    const own = db.table('user_preferences').filter((r) => r.user_id === `user-0a-${role}`);
    expect(own).toHaveLength(1);
    expect(Date.parse((own[0].notification_prefs as Record<string, string>)[DISMISSED_KEY])).not.toBeNaN();
    expect(db.table('user_preferences').filter((r) => r.user_id !== `user-0a-${role}`)).toEqual(others);
    expect(db.table('referrals')).toHaveLength(1);
    expect(h.revalidated).toEqual(['/home']);
  });

  it('ACTION-4FDB462605BB a child on a kid login dismisses only their own card', async () => {
    signInAs('child', { kidLogin: true });
    const others = structuredClone(db.table('user_preferences'));
    expect(await dismissReferralHomeCardAction()).toEqual({ ok: true });
    expect(db.table('user_preferences').filter((r) => r.user_id !== 'user-0a-child')).toEqual(others);
    expect(db.table('user_preferences').filter((r) => r.user_id === 'user-0a-child')).toHaveLength(1);
  });

  it('ACTION-4FDB462605BB a parent of A with a saved row updates theirs only, and B\'s row is untouched', async () => {
    db.seed('user_preferences', [{ user_id: 'user-0a-parent', notification_prefs: { digest: 'daily' } }]);
    const bBefore = structuredClone(db.table('user_preferences').filter((r) => r.user_id === 'user-0b-parent'));
    signInAs('parent');
    expect(await dismissReferralHomeCardAction()).toEqual({ ok: true });
    const row = db.table('user_preferences').find((r) => r.user_id === 'user-0a-parent');
    expect(row?.notification_prefs).toEqual({ [DISMISSED_KEY]: expect.any(String), digest: 'daily' });
    expect(db.table('user_preferences').filter((r) => r.user_id === 'user-0b-parent')).toEqual(bBefore);
    expect(db.table('user_preferences')).toHaveLength(2);
  });

  it('ACTION-4FDB462605BB a signed-out caller writes nothing', async () => {
    const before = everything();
    await expect(dismissReferralHomeCardAction()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });
});
