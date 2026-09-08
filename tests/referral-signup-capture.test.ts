// M39 — a `/signup?ref=CODE` visit ends, after onboarding, as a referrals row
// with source 'signup_link'. The capture is exercised against the in-memory
// Supabase (real rows, real filters) with a fake cookie jar standing in for
// next/headers, and the wiring (signup form → cookie + auth metadata → the
// onboarding finalizer) is pinned at source level so it cannot quietly drop out.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { expectTranslates } from './helpers/translated';
import {
  REFERRAL_COOKIE, REFERRAL_SIGNUP_SOURCE, isPlausibleReferralCode, referralCodeFromSignup,
} from '@/lib/referrals/core';

const REFERRER = '11111111-1111-4111-8111-111111111111';
const REFERRED = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

// A cookie jar with the slice of next/headers' surface the capture uses.
const store = new Map<string, string>();
const jar = {
  get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
  set: (name: string, value: string) => { store.set(name, value); },
  delete: (name: string) => { store.delete(name); },
};
vi.mock('next/headers', () => ({ cookies: async () => jar, headers: async () => new Headers() }));

const db = createInMemorySupabase({
  uniques: { referrals: [['referred_family_id']], referral_codes: [['family_id'], ['code']] },
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_family_id: null, referred_email: null, referrer_reward_cents: 0, referred_reward_cents: 0, converted_at: null, rewarded_at: null, metadata: {} },
  },
});
const client = db as unknown as SupabaseClient<Database>;
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
  createServer: async () => client,
}));

const { captureSignupReferral } = await import('@/lib/referrals/signup');

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  db.reset();
  store.clear();
  db.seed('referral_codes', [{ family_id: REFERRER, code: 'SMITH-7K4Q', created_by: null }]);
});

describe('referralCodeFromSignup (pure)', () => {
  it('accepts a generated-shaped code and rejects junk', () => {
    expect(isPlausibleReferralCode('smith-7k4q')).toBe(true);
    expect(isPlausibleReferralCode('AB')).toBe(false);
    expect(isPlausibleReferralCode('<script>')).toBe(false);
    expect(isPlausibleReferralCode('')).toBe(false);
    expect(isPlausibleReferralCode(null)).toBe(false);
  });

  it('prefers the cookie, falls back to the auth metadata, normalizes both', () => {
    expect(referralCodeFromSignup({ cookieCode: ' smith-7k4q ', metadataCode: 'OTHER-1234' })).toBe('SMITH-7K4Q');
    expect(referralCodeFromSignup({ cookieCode: null, metadataCode: 'other-2345' })).toBe('OTHER-2345');
    expect(referralCodeFromSignup({ cookieCode: 'x', metadataCode: 42 })).toBeNull();
    expect(referralCodeFromSignup({})).toBeNull();
  });
});

describe('captureSignupReferral', () => {
  it('turns the signup cookie into a signed_up referral with source signup_link and clears the cookie', async () => {
    store.set(REFERRAL_COOKIE, 'SMITH-7K4Q');
    const out = await captureSignupReferral({ referredFamilyId: REFERRED, referredEmail: 'New@Example.com' });
    expect(out).toEqual({ outcome: 'applied', code: 'SMITH-7K4Q' });

    const rows = db.table('referrals');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'SMITH-7K4Q',
      referrer_family_id: REFERRER,
      referred_family_id: REFERRED,
      referred_email: 'new@example.com',
      status: 'signed_up',
      source: REFERRAL_SIGNUP_SOURCE,
      referrer_reward_cents: 1000,
      referred_reward_cents: 1000,
    });
    expect(store.has(REFERRAL_COOKIE)).toBe(false);
  });

  it('is applied once per family: a replayed finalization answers quietly and adds no row', async () => {
    store.set(REFERRAL_COOKIE, 'SMITH-7K4Q');
    await captureSignupReferral({ referredFamilyId: REFERRED, referredEmail: 'new@example.com' });
    store.set(REFERRAL_COOKIE, 'SMITH-7K4Q');
    const again = await captureSignupReferral({ referredFamilyId: REFERRED, referredEmail: 'new@example.com' });
    expect(again).toEqual({ outcome: 'already_referred', code: 'SMITH-7K4Q' });
    expect(db.table('referrals')).toHaveLength(1);
    expect(store.has(REFERRAL_COOKIE)).toBe(false);
  });

  it('falls back to the auth metadata when the cookie is gone (email confirmation in another browser)', async () => {
    const out = await captureSignupReferral({ referredFamilyId: THIRD, referredEmail: 'third@example.com', metadataCode: 'smith-7k4q' });
    expect(out).toEqual({ outcome: 'applied', code: 'SMITH-7K4Q' });
    expect(db.table('referrals')[0]).toMatchObject({ referred_family_id: THIRD, source: REFERRAL_SIGNUP_SOURCE });
  });

  it('does nothing without a code, and never lets a family refer itself', async () => {
    expect(await captureSignupReferral({ referredFamilyId: REFERRED, referredEmail: null })).toEqual({ outcome: 'none' });
    store.set(REFERRAL_COOKIE, 'SMITH-7K4Q');
    const own = await captureSignupReferral({ referredFamilyId: REFERRER, referredEmail: 'me@example.com' });
    expect(own.outcome).toBe('rejected');
    expect(db.table('referrals')).toHaveLength(0);
  });

  it('keeps the cookie on an unknown code so a retried finalization can try again', async () => {
    store.set(REFERRAL_COOKIE, 'NOPE-0000');
    const out = await captureSignupReferral({ referredFamilyId: REFERRED, referredEmail: null });
    expect(out).toMatchObject({ outcome: 'rejected', code: 'NOPE-0000' });
    expect(store.get(REFERRAL_COOKIE)).toBe('NOPE-0000');
    expect(db.table('referrals')).toHaveLength(0);
  });
});

describe('signup capture wiring (source)', () => {
  const form = readFileSync('components/auth/signup-form.tsx', 'utf8');
  const cookieAction = readFileSync('app/(auth)/signup/actions.ts', 'utf8');
  const onboarding = readFileSync('app/onboarding/actions.ts', 'utf8');
  const referralActions = readFileSync('app/(app)/referrals/actions.ts', 'utf8');

  it('the signup form reads ?ref=, remembers it server-side, and writes it into the auth metadata', () => {
    expect(form).toContain("params.get('ref')");
    expect(form).toContain('rememberReferralCodeAction(referralCode)');
    expect(form).toContain('referral_code: referralCode');
    expect(form).toContain("t('signup.referralCodeNoted', { code: referralCode })");
  });

  it('the cookie is httpOnly, same-site and short-lived', () => {
    expect(cookieAction).toContain('jar.set(REFERRAL_COOKIE, code, {');
    expect(cookieAction).toContain('httpOnly: true');
    expect(cookieAction).toContain("sameSite: 'lax'");
    expect(cookieAction).toContain('maxAge: REFERRAL_COOKIE_MAX_AGE_SEC');
  });

  it('finalizeOnboardingAction applies the referral exactly once, as a separate helper call', () => {
    const finalize = onboarding.slice(onboarding.indexOf('export async function finalizeOnboardingAction'));
    expect(finalize.match(/captureSignupReferral\(/g)).toHaveLength(1);
    expect(finalize).toContain('metadataCode: auth.user.user_metadata?.referral_code');
    // Attribution happens after the family exists and its owner is a member.
    expect(finalize.indexOf('captureSignupReferral(')).toBeGreaterThan(finalize.indexOf("from('family_members').upsert("));
  });

  it('every way applying a code can fail reaches the family as translated words', () => {
    // lib/ has no translator, so applyReferralCode answers with a machine code
    // and English; the action maps EVERY code to a catalogue key. A new code
    // without a key would not type-check (Record<ApplyFailureCode, string>),
    // and these pin the wording that key still carries.
    expect(referralActions).toContain('const APPLY_FAILURE_KEY: Record<ApplyFailureCode, string>');
    expect(referralActions).toContain('reason: t(APPLY_FAILURE_KEY[result.code])');
    for (const key of [
      'referralActions.enterAReferralCode',
      'referralActions.codeNotFound',
      'referralActions.cannotUseYourOwnCode',
      'referralActions.familyAlreadyUsedACode',
      'referralActions.couldNotApplyCode',
      'referralActions.programPaused',
    ]) {
      expect(referralActions, `should map a failure to ${key}`).toContain(`'${key}'`);
    }
    expectTranslates(referralActions, 'referralActions.programPaused', 'The referral program is currently paused.');
  });
});
