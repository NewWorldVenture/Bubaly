'use server';

// lib/i18n/actions.ts — persist a visitor's language choice.

import { cookies } from 'next/headers';

import { isLocaleCode, findLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/locales';
import { encodePendingChoice, LOCALE_PENDING_COOKIE } from '@/lib/i18n/pending-choice';
import { createServer } from '@/lib/supabase/server';

/**
 * Record an explicit locale choice.
 *
 * Validated against the catalogue before it is written, so a crafted request
 * can never plant an arbitrary cookie value that later code reads back.
 * Rejection is silent-but-honest: the return value says whether it took, and an
 * unknown code simply leaves the existing preference alone.
 *
 * Not httpOnly — the value is a display preference, not a credential, and the
 * client reads it to keep the picker in sync without a round trip. `lax` keeps
 * it attached to normal top-level navigation while staying off cross-site POSTs.
 *
 * TWO places, for two readers. The cookie is for the UI: it is readable on the
 * very first render, so a chosen language never flashes English first, and it
 * works for a visitor with no account. The profile row (profiles.locale, 0466)
 * is the durable copy: it follows the person to a new device at sign-in
 * (lib/i18n/sync.ts), and it is what Bubaly's outbound messages are to be
 * written in (finalaudit I18N-001) — those are composed by crons that never see
 * a cookie. A signed-in member's choice is written to both; a visitor's only to
 * the cookie, and sign-in or onboarding copies it onto the profile.
 *
 * HONEST about the second write. The switch never fails because a database was
 * slow — the cookie has already taken, so the page is in the new language —
 * but the result says whether the profile took too, and if not, why:
 *
 *   { ok: false }                            not a shipped language; nothing written
 *   { ok: true, stored: true }               cookie and profile
 *   { ok: true, stored: false, profile: 'signed-out' }  a visitor: cookie only, by design
 *   { ok: true, stored: false, profile: 'unverified' }  who is asking could not be looked up
 *   { ok: true, stored: false, profile: 'refused' }     the write reached no row
 *   { ok: true, stored: false, profile: 'failed' }      the write errored or threw
 */
export type LocaleChoice =
  | { ok: false; stored: false }
  | { ok: true; stored: true }
  | { ok: true; stored: false; profile: ProfileWrite };

type ProfileWrite = 'signed-out' | 'unverified' | 'refused' | 'failed';

export async function setLocale(code: string): Promise<LocaleChoice> {
  if (!isLocaleCode(code)) return { ok: false, stored: false };

  // The cookie is written exactly as it was before the profile existed; its
  // one reader (getLocaleContext -> resolveLocale) matches case-insensitively.
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, code, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  // The profile gets the catalogue's spelling: the column's CHECK is exact.
  const canonical = findLocale(code)!.code;
  const { profile, userId } = await storeForSignedInUser(canonical);
  // An explicit choice the profile did not take is remembered as PENDING, with
  // whose it is, so the next sign-in stores it; a plain cookie alone never
  // overwrites a saved preference (lib/i18n/pending-choice.ts).
  if (profile === 'stored') {
    jar.delete(LOCALE_PENDING_COOKIE);
    return { ok: true, stored: true };
  }
  // An identity that could not be looked up is neither signed out nor anyone
  // in particular: a pending choice with no owner would be adopted by the next
  // account to sign in here (#705 comment 5921554978). So none is left, and an
  // older one goes too rather than outrank this newer choice. The same holds
  // for a failure before anyone was identified (the client could not start).
  if (profile === 'unverified' || (profile !== 'signed-out' && !userId)) {
    jar.delete(LOCALE_PENDING_COOKIE);
    return { ok: true, stored: false, profile };
  }
  jar.set(LOCALE_PENDING_COOKIE, encodePendingChoice(canonical, profile === 'signed-out' ? null : userId), {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  });
  return { ok: true, stored: false, profile };
}

/**
 * Write the choice onto the caller's own profile, on the caller's own session:
 * RLS (profiles_update_self, and 0466's restrictive own-row policy) is what
 * limits it to their row. A visitor with no session stores nothing and that is
 * not a failure — the cookie already took.
 *
 * A failed or refused write is logged and REPORTED, never thrown: the page is
 * already in the new language, and the next switch or sign-in writes it again.
 */
async function storeForSignedInUser(code: string): Promise<{ profile: 'stored' | ProfileWrite; userId: string | null }> {
  let userId: string | null = null;
  const result = (profile: 'stored' | ProfileWrite) => ({ profile, userId });
  try {
    const supabase = await createServer();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user) {
      // Only a missing session is signed out; any other error is an outage.
      if (!authError || isSessionMissing(authError)) return result('signed-out');
      console.error('[i18n] could not look up who is choosing a language', authError);
      return result('unverified');
    }
    userId = user.id;
    const { data, error } = await supabase
      .from('profiles')
      .update({ locale: code })
      .eq('id', user.id)
      .select('id');
    if (error) {
      console.error('[i18n] could not store the language choice on the profile', error);
      return result('failed');
    }
    if ((data ?? []).length !== 1) {
      console.error('[i18n] the language choice reached no profile row (refused or missing)');
      return result('refused');
    }
    return result('stored');
  } catch (e) {
    console.error('[i18n] could not store the language choice on the profile', e);
    return result('failed');
  }
}

/** Supabase's answer for a visitor with no session, as lib/supabase/auth.ts reads it. */
function isSessionMissing(error: { name?: unknown; code?: unknown; message?: unknown }): boolean {
  return error.name === 'AuthSessionMissingError' || error.code === 'session_missing'
    || (typeof error.message === 'string' && /auth session missing/i.test(error.message));
}
