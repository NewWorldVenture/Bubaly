// lib/i18n/pending-choice.ts — a language choice the profile has not taken yet.
//
// The `bubaly-locale` cookie alone cannot say WHY it holds a language: an
// explicit choice made while signed out, a language sign-in restored from the
// profile, or one another account left behind on a shared browser all look the
// same. Treating every cookie/profile mismatch as a new choice let a stale
// restored cookie, or someone else's, overwrite the saved preference (#705
// review). So an explicit choice that did NOT reach the profile is recorded
// here, separately, with whose it is:
//
//   `de-DE`          chosen while signed out: the next account to sign in on
//                    this browser adopts it (it is that visitor's choice)
//   `de-DE@<userId>` a signed-in choice whose profile write failed: only that
//                    account retries it; anyone else ignores it
//
// Framework-free; the cookie is httpOnly, since only the server reads it.
import { findLocale, type LocaleCode } from '@/lib/i18n/locales';

export const LOCALE_PENDING_COOKIE = 'bubaly-locale-pending';

export type PendingChoice = { locale: LocaleCode; owner: string | null };

export function encodePendingChoice(locale: LocaleCode, owner: string | null): string {
  return owner ? `${locale}@${owner}` : locale;
}

/** The pending choice a cookie value records, or null for anything unreadable. */
export function decodePendingChoice(value: string | null | undefined): PendingChoice | null {
  if (!value) return null;
  const at = value.indexOf('@');
  const locale = findLocale(at < 0 ? value : value.slice(0, at))?.code;
  if (!locale) return null;
  const owner = at < 0 ? null : value.slice(at + 1);
  if (owner !== null && !/^[0-9A-Za-z-]{1,64}$/.test(owner)) return null;
  return { locale, owner };
}
