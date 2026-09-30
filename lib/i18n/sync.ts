// lib/i18n/sync.ts — keep a signed-in person's two copies of their language in
// step: the cookie the UI reads, and profiles.locale (0466), the durable copy
// that follows them to a new device and that Bubaly's outbound messages are to
// be written in (finalaudit I18N-001).
//
// Called where a person has just become someone — signed in, joined a family
// from an invite, finished onboarding — from a server action, where a cookie
// can still be written.
import 'server-only';
import { cookies } from 'next/headers';

import { findLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type LocaleCode } from '@/lib/i18n/locales';
import { getLocaleContext } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';

export type LanguageSync =
  | { kind: 'none' }
  /** The profile took this device's language (a choice made signed out, or the one onboarding was read in). */
  | { kind: 'stored'; locale: LocaleCode }
  /** This device took the profile's language: the choice followed the person to a second device. */
  | { kind: 'restored'; locale: LocaleCode }
  | { kind: 'in-step'; locale: LocaleCode };

/**
 * Pure decision, so it can be pinned without a request:
 *
 *   cookie set, profile differs or empty -> store the cookie. The cookie is
 *        the most recent explicit choice on this device; setLocale writes both
 *        for a signed-in person, so a mismatch means they chose while signed out.
 *   no cookie, profile set               -> restore it onto this device, so a
 *        language chosen on the laptop is the phone's language after sign-in.
 *   neither                              -> store the language this request was
 *        resolved to (geo, then Accept-Language, then en-US). It is the language
 *        they have just read the whole sign-up in without changing it, and it is
 *        a better answer for their email than an English nobody chose.
 */
export function decideLanguageSync(input: {
  cookie: string | null | undefined;
  stored: string | null | undefined;
  resolved: LocaleCode;
}): LanguageSync {
  const cookie = findLocale(input.cookie)?.code ?? null;
  const stored = findLocale(input.stored)?.code ?? null;
  if (cookie) return cookie === stored ? { kind: 'in-step', locale: cookie } : { kind: 'stored', locale: cookie };
  if (stored) return { kind: 'restored', locale: stored };
  return { kind: 'stored', locale: input.resolved };
}

/**
 * Apply the decision for the signed-in caller. Best-effort: a language must
 * never be the reason a sign-in or an onboarding fails, so every failure is
 * logged and answered with `none`.
 */
export async function syncLanguageForSignedInUser(): Promise<LanguageSync> {
  try {
    const supabase = await createServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { kind: 'none' };
    const [{ data: profile, error }, jar, { locale }] = await Promise.all([
      supabase.from('profiles').select('locale').eq('id', user.id).maybeSingle(),
      cookies(),
      getLocaleContext(),
    ]);
    if (error) {
      console.error('[i18n] could not read the stored language', error);
      return { kind: 'none' };
    }
    const decision = decideLanguageSync({
      cookie: jar.get(LOCALE_COOKIE)?.value,
      stored: profile?.locale,
      resolved: locale.code,
    });
    if (decision.kind === 'stored') {
      const { error: writeError } = await supabase.from('profiles').update({ locale: decision.locale }).eq('id', user.id);
      if (writeError) {
        console.error('[i18n] could not store the language on the profile', writeError);
        return { kind: 'none' };
      }
    } else if (decision.kind === 'restored') {
      jar.set(LOCALE_COOKIE, decision.locale, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    }
    return decision;
  } catch (e) {
    console.error('[i18n] language sync failed', e);
    return { kind: 'none' };
  }
}
