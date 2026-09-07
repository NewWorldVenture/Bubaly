import 'server-only';

// lib/referrals/signup.ts — turn a remembered `?ref=` into a referrals row.
//
// Called exactly once per family from finalizeOnboardingAction. Reads the
// signup cookie (or the auth metadata the email form wrote), applies the code
// with source 'signup_link', and clears the cookie once the code has been
// consumed or found to be already used. Best-effort by design: a referral
// that cannot be recorded is logged, and never blocks a family finishing
// onboarding.
import { cookies } from 'next/headers';
import { REFERRAL_COOKIE, REFERRAL_SIGNUP_SOURCE, referralCodeFromSignup } from '@/lib/referrals/core';
import { applyReferralCode } from '@/lib/referrals/server';

export type SignupReferralOutcome =
  | { outcome: 'none' }
  | { outcome: 'applied'; code: string }
  | { outcome: 'already_referred'; code: string }
  | { outcome: 'rejected'; code: string; reason: string };

async function readCookieCode(): Promise<string | null> {
  try {
    const jar = await cookies();
    return jar.get(REFERRAL_COOKIE)?.value ?? null;
  } catch {
    return null; // no request scope (a background caller) — fall back to metadata
  }
}

async function clearCookie(): Promise<void> {
  try {
    const jar = await cookies();
    if (jar.get(REFERRAL_COOKIE)) jar.delete(REFERRAL_COOKIE);
  } catch { /* outside a request, or a Server Component render — nothing to clear */ }
}

export async function captureSignupReferral(input: {
  referredFamilyId: string;
  referredEmail: string | null;
  /** `auth.user.user_metadata.referral_code`, written by the email signup form. */
  metadataCode?: unknown;
}): Promise<SignupReferralOutcome> {
  const code = referralCodeFromSignup({ cookieCode: await readCookieCode(), metadataCode: input.metadataCode });
  if (!code) return { outcome: 'none' };

  let result: Awaited<ReturnType<typeof applyReferralCode>>;
  try {
    result = await applyReferralCode({
      rawCode: code,
      referredFamilyId: input.referredFamilyId,
      referredEmail: input.referredEmail,
      source: REFERRAL_SIGNUP_SOURCE,
    });
  } catch (err) {
    console.error('[referrals/signup] referral attribution failed', { code, familyId: input.referredFamilyId, err });
    return { outcome: 'rejected', code, reason: 'attribution failed' };
  }

  if (result.ok) {
    await clearCookie();
    return { outcome: 'applied', code };
  }
  if (result.code === 'already_referred') {
    // A replayed finalization, or a family that typed the code by hand first.
    // Either way the referral exists; the cookie has done its job.
    await clearCookie();
    return { outcome: 'already_referred', code };
  }
  // Unknown code, own code, paused program, or a write failure: leave the
  // cookie so a retry of onboarding can try again, and say why in the log.
  console.warn('[referrals/signup] referral code not applied', { code, familyId: input.referredFamilyId, reason: result.reason });
  return { outcome: 'rejected', code, reason: result.reason };
}
