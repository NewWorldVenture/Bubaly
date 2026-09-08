'use server';

// app/(auth)/signup/actions.ts — remember a `/signup?ref=CODE` visit.
//
// The signup form calls this once when it mounts with a ref. The code goes
// into a short-lived httpOnly cookie so every signup avenue (email, phone,
// Google) carries it through email confirmation and into the onboarding
// wizard, where `captureSignupReferral` turns it into a referrals row.
import { cookies } from 'next/headers';
import { isPlausibleReferralCode, normalizeCode, REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE_SEC } from '@/lib/referrals/core';

export async function rememberReferralCodeAction(rawCode: string): Promise<{ ok: true; code: string } | { ok: false }> {
  if (typeof rawCode !== 'string' || !isPlausibleReferralCode(rawCode)) return { ok: false };
  const code = normalizeCode(rawCode);
  try {
    const jar = await cookies();
    jar.set(REFERRAL_COOKIE, code, {
      path: '/',
      maxAge: REFERRAL_COOKIE_MAX_AGE_SEC,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return { ok: true, code };
  } catch (err) {
    console.error('[referrals/signup] referral cookie write failed', err);
    return { ok: false };
  }
}
