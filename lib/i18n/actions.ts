'use server';

// lib/i18n/actions.ts — persist a visitor's language choice.

import { cookies } from 'next/headers';

import { isLocaleCode, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/locales';

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
 */
export async function setLocale(code: string): Promise<{ ok: boolean }> {
  if (!isLocaleCode(code)) return { ok: false };

  const jar = await cookies();
  jar.set(LOCALE_COOKIE, code, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  return { ok: true };
}
