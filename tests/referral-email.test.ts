// M39 — the "Email an invite" path: a friend gets the referrer's code through
// the same transport as the member InviteEmail, every send is a timestamp on
// the invited family's referrals row, and that is what the 10-a-day limit is
// counted from. The pure policy is checked on its own (child-throttle style),
// then the persisted state against the in-memory Supabase.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { expectSays, expectTranslates } from './helpers/translated';
import {
  DEFAULT_REFERRAL_CONFIG, REFERRAL_EMAIL_POLICY, REFERRAL_EMAIL_SOURCE,
  evaluateReferralEmailThrottle, referralEmailSendTimes, withReferralEmailSent,
} from '@/lib/referrals/core';

const REFERRER = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const NEW_FAMILY = '22222222-2222-4222-8222-222222222222';

const db = createInMemorySupabase({
  uniques: { referrals: [['referred_family_id']] },
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_family_id: null, referred_email: null, referrer_reward_cents: 0, referred_reward_cents: 0, converted_at: null, rewarded_at: null, metadata: {} },
  },
});
const client = db as unknown as SupabaseClient<Database>;
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
  createServer: async () => client,
}));

const { recordReferralEmailInvite, rollbackReferralEmailInvite, applyReferralCode } = await import('@/lib/referrals/server');

const T0 = new Date('2026-09-07T12:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => { db.reset(); });

describe('referral email throttle (pure policy)', () => {
  it('allows up to the limit inside the window and blocks the next with a retry-after', () => {
    const stamps = Array.from({ length: REFERRAL_EMAIL_POLICY.limit - 1 }, (_, i) => minutes(-i * 10).toISOString());
    const rows = [{ metadata: { email_sent_at: stamps } }];
    const nine = evaluateReferralEmailThrottle(rows, T0);
    expect(nine).toMatchObject({ allowed: true, used: 9, remaining: 1, retryAfterSec: 0 });

    const ten = evaluateReferralEmailThrottle([{ metadata: withReferralEmailSent(rows[0].metadata, T0) }], T0);
    expect(ten).toMatchObject({ allowed: false, used: 10, remaining: 0 });
    // The oldest send was 80 minutes ago; it leaves the 24h window in 22h40m.
    expect(ten.retryAfterSec).toBe((24 * 60 - 80) * 60);
  });

  it('counts across all of the family rows, and forgets sends older than the window', () => {
    const old = new Date(T0.getTime() - REFERRAL_EMAIL_POLICY.windowMs - 1000).toISOString();
    const rows = [
      { metadata: { email_sent_at: [old, old, old, minutes(-1).toISOString()] } },
      { metadata: { email_sent_at: Array.from({ length: 5 }, (_, i) => minutes(-i - 2).toISOString()) } },
      { metadata: {} },
      { metadata: null },
    ];
    expect(evaluateReferralEmailThrottle(rows, T0)).toMatchObject({ allowed: true, used: 6, remaining: 4 });
  });

  it('records a send without clobbering other metadata, keeping the last 50', () => {
    const next = withReferralEmailSent({ reward: { referrer_txn: 'cbtxn_1' }, email_sent_at: ['bad', T0.toISOString()] }, minutes(1));
    expect(next.reward).toEqual({ referrer_txn: 'cbtxn_1' });
    expect(referralEmailSendTimes(next)).toEqual(['bad', T0.toISOString(), minutes(1).toISOString()]);
    let m: unknown = {};
    for (let i = 0; i < 60; i++) m = withReferralEmailSent(m, minutes(i));
    expect(referralEmailSendTimes(m)).toHaveLength(50);
  });
});

describe('recordReferralEmailInvite (persisted state)', () => {
  const base = { referrerFamilyId: REFERRER, code: 'SMITH-7K4Q', config: DEFAULT_REFERRAL_CONFIG };

  it('creates a pending referral row for a new address with the send stamped on it', async () => {
    const out = await recordReferralEmailInvite(client, { ...base, email: ' Friend@Example.com ', now: T0 });
    expect(out).toMatchObject({ ok: true, created: true, remaining: 9 });
    const rows = db.table('referrals');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'SMITH-7K4Q', referrer_family_id: REFERRER, referred_family_id: null, referred_email: 'friend@example.com',
      status: 'pending', source: REFERRAL_EMAIL_SOURCE, referrer_reward_cents: 1000, referred_reward_cents: 1000,
    });
    expect(referralEmailSendTimes(rows[0].metadata)).toEqual([T0.toISOString()]);
  });

  it('a repeat send to the same address reuses the row instead of inviting a second family', async () => {
    await recordReferralEmailInvite(client, { ...base, email: 'friend@example.com', now: T0 });
    const again = await recordReferralEmailInvite(client, { ...base, email: 'FRIEND@example.com', now: minutes(5) });
    expect(again).toMatchObject({ ok: true, created: false, remaining: 8 });
    expect(db.table('referrals')).toHaveLength(1);
    expect(referralEmailSendTimes(db.table('referrals')[0].metadata)).toEqual([T0.toISOString(), minutes(5).toISOString()]);
  });

  it('throttles the 11th send in a day per family, not per address, and other families are unaffected', async () => {
    for (let i = 0; i < REFERRAL_EMAIL_POLICY.limit; i++) {
      const out = await recordReferralEmailInvite(client, { ...base, email: `f${i}@example.com`, now: minutes(i) });
      expect(out.ok).toBe(true);
    }
    const eleventh = await recordReferralEmailInvite(client, { ...base, email: 'late@example.com', now: minutes(11) });
    expect(eleventh).toMatchObject({ ok: false, reason: 'throttled' });
    expect((eleventh as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    expect(db.table('referrals')).toHaveLength(REFERRAL_EMAIL_POLICY.limit);

    const other = await recordReferralEmailInvite(client, { ...base, referrerFamilyId: OTHER, code: 'JONES-AB12', email: 'x@example.com', now: minutes(11) });
    expect(other).toMatchObject({ ok: true, created: true });

    // A day later the window has rolled and the family may send again.
    const tomorrow = new Date(T0.getTime() + REFERRAL_EMAIL_POLICY.windowMs + 60_000);
    expect(await recordReferralEmailInvite(client, { ...base, email: 'late@example.com', now: tomorrow })).toMatchObject({ ok: true });
  });

  it('rollback removes a fresh row, or just the stamp on a reused one, so a failed send is not counted', async () => {
    const first = await recordReferralEmailInvite(client, { ...base, email: 'friend@example.com', now: T0 });
    if (!first.ok) throw new Error('setup');
    await rollbackReferralEmailInvite(client, { rowId: first.rowId, created: first.created, sentAt: T0 });
    expect(db.table('referrals')).toHaveLength(0);

    await recordReferralEmailInvite(client, { ...base, email: 'friend@example.com', now: T0 });
    const second = await recordReferralEmailInvite(client, { ...base, email: 'friend@example.com', now: minutes(1) });
    if (!second.ok) throw new Error('setup');
    await rollbackReferralEmailInvite(client, { rowId: second.rowId, created: second.created, sentAt: minutes(1) });
    expect(db.table('referrals')).toHaveLength(1);
    expect(referralEmailSendTimes(db.table('referrals')[0].metadata)).toEqual([T0.toISOString()]);
  });

  it('when the invited family signs up with that address, the pending row becomes the signed-up one', async () => {
    db.seed('referral_codes', [{ family_id: REFERRER, code: 'SMITH-7K4Q', created_by: null }]);
    await recordReferralEmailInvite(client, { ...base, email: 'friend@example.com', now: T0 });
    const applied = await applyReferralCode({ rawCode: 'smith-7k4q', referredFamilyId: NEW_FAMILY, referredEmail: 'Friend@Example.com', source: 'signup_link' });
    expect(applied).toEqual({ ok: true });
    const rows = db.table('referrals');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referred_family_id: NEW_FAMILY, status: 'signed_up', source: 'signup_link', referred_email: 'friend@example.com' });
    expect(referralEmailSendTimes(rows[0].metadata)).toEqual([T0.toISOString()]);
  });
});

describe('referral email wiring (source)', () => {
  const actions = readFileSync('app/(app)/referrals/actions.ts', 'utf8');
  const panel = readFileSync('components/referrals/referral-panel.tsx', 'utf8');
  const email = readFileSync('lib/emails/referral.tsx', 'utf8');
  const invite = readFileSync('app/api/email/invite/route.ts', 'utf8');

  it('sends through the same transport as the member invite, and rolls back on a failed send', () => {
    expect(invite).toContain('sendReactEmail({');
    expect(actions).toContain('sendReactEmail({');
    expect(actions).toContain('React.createElement(ReferralEmail, {');
    expect(actions).toContain('await rollbackReferralEmailInvite(service, { rowId: record.rowId, created: record.created, sentAt })');
    expect(actions).toContain("if (record.reason === 'throttled')");
    expectTranslates(actions, 'referralActions.couldNotSendEmail', 'We could not send that invite right now. Please try again.');
    expectTranslates(actions, 'referralActions.enterAValidEmail', 'Enter a valid email address.');
    expect(actions).toContain("t('referralActions.dailyEmailLimitReached', { limit: REFERRAL_EMAIL_POLICY.limit })");
  });

  it('the email carries the code and the signup link', () => {
    expect(email).toContain('{code}');
    expect(email).toContain('href={link}');
    expect(email).toContain('{rewardLabel}');
  });

  it('the panel offers the form, translated', () => {
    expect(panel).toContain('sendReferralEmailAction(address)');
    expectSays(panel, 'referralPanel.emailAnInvite', 'Email an invite');
    expectSays(panel, 'referralPanel.sendInvite', 'Send invite');
    expect(panel).toContain("t('referralPanel.inviteEmailSent', { email: res.email })");
  });
});
