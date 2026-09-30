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
import { decodePendingChoice, LOCALE_PENDING_COOKIE, type PendingChoice } from '@/lib/i18n/pending-choice';
import { getLocaleContext } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';

export type LanguageSync =
  | { kind: 'none' }
  /** The profile took an explicit choice it did not have yet (made signed out, or a save that failed), or the language this request was served in. */
  | { kind: 'stored'; locale: LocaleCode }
  /** This device took the profile's language: the choice followed the person to a second device. */
  | { kind: 'restored'; locale: LocaleCode }
  | { kind: 'in-step'; locale: LocaleCode };

/**
 * Pure decision, so it can be pinned without a request.
 *
 * The plain cookie does not say whose choice it is or when it was made (a
 * language sign-in restored, one another account left on a shared browser),
 * so it never outranks the saved preference on its own. Only an explicit
 * choice that has not reached the profile does: the pending choice
 * (lib/i18n/pending-choice.ts).
 *
 *   pending choice this user may claim -> store it. Signed out (no owner:
 *        the visitor who chose is the one signing in), or this user's own
 *        failed save being retried. Someone else's is ignored.
 *   profile set                        -> it wins: restore it onto this device
 *        when the cookie differs, so a stale restored cookie or another
 *        account's cannot overwrite the latest explicit choice.
 *   no profile, cookie set             -> store the cookie (a choice made
 *        before the profile kept one).
 *   neither                            -> store the language this request was
 *        resolved to (geo, then Accept-Language, then en-US): the language
 *        they just read the sign-up in, a better answer for their email than
 *        an English nobody chose.
 */
export function decideLanguageSync(input: {
  cookie: string | null | undefined;
  stored: string | null | undefined;
  resolved: LocaleCode;
  pending?: PendingChoice | null;
  userId?: string;
}): LanguageSync {
  const cookie = findLocale(input.cookie)?.code ?? null;
  const stored = findLocale(input.stored)?.code ?? null;
  const pending = claimable(input.pending, input.userId)?.locale ?? null;
  if (pending) return pending === stored ? { kind: 'in-step', locale: pending } : { kind: 'stored', locale: pending };
  if (stored) return cookie === stored ? { kind: 'in-step', locale: stored } : { kind: 'restored', locale: stored };
  if (cookie) return { kind: 'stored', locale: cookie };
  return { kind: 'stored', locale: input.resolved };
}

/** The pending choice this user may settle: an unowned one, or their own. Someone else's is null. */
export function claimable(pending: PendingChoice | null | undefined, userId: string | undefined): PendingChoice | null {
  return pending && (pending.owner === null || pending.owner === userId) ? pending : null;
}

/**
 * How long sign-in and onboarding wait for the language, at most. A language
 * is optional there: a slow profile read or write must not hold up the
 * person's landing page or the end of their onboarding (#705 review). On the
 * deadline the database requests are aborted, nothing further is written,
 * and the answer is `none`; the next sign-in or switch tries again.
 */
export const LANGUAGE_SYNC_BUDGET_MS = 1500;

const cookieOptions = () => ({
  path: '/',
  maxAge: LOCALE_COOKIE_MAX_AGE,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
});

/**
 * Apply the decision for the signed-in caller. Best-effort and bounded: a
 * language must never be the reason a sign-in or an onboarding fails or waits,
 * so every failure is logged and answered with `none`, and so is running out
 * of `budgetMs`.
 */
export async function syncLanguageForSignedInUser(budgetMs: number = LANGUAGE_SYNC_BUDGET_MS): Promise<LanguageSync> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LanguageSync>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      console.error(`[i18n] language sync gave up after ${budgetMs}ms; sign-in carries on`);
      resolve({ kind: 'none' });
    }, budgetMs);
  });
  try {
    return await Promise.race([syncWithin(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function syncWithin(signal: AbortSignal): Promise<LanguageSync> {
  try {
    const supabase = await createServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || signal.aborted) return { kind: 'none' };
    const [{ data: profile, error }, jar, { locale }] = await Promise.all([
      supabase.from('profiles').select('locale').eq('id', user.id).abortSignal(signal).maybeSingle(),
      cookies(),
      getLocaleContext(),
    ]);
    if (signal.aborted) return { kind: 'none' };
    if (error) {
      console.error('[i18n] could not read the stored language', error);
      return { kind: 'none' };
    }
    const pending = decodePendingChoice(jar.get(LOCALE_PENDING_COOKIE)?.value);
    const visible = findLocale(jar.get(LOCALE_COOKIE)?.value)?.code ?? null;
    const decision = decideLanguageSync({
      cookie: visible,
      stored: profile?.locale,
      resolved: locale.code,
      pending,
      userId: user.id,
    });
    const claimed = claimable(pending, user.id);
    // The owner's explicit choice is what this device shows, saved yet or not:
    // another account may have restored its own language onto the shared
    // browser since (#705 comment 5921554978).
    if (claimed && visible !== claimed.locale) jar.set(LOCALE_COOKIE, claimed.locale, cookieOptions());
    if (decision.kind === 'stored') {
      // Confirmed, not assumed: the write reads back the row it changed, so a
      // profile RLS refused (or one that does not exist yet) is reported as not
      // stored rather than claimed.
      const { data: written, error: writeError } = await supabase
        .from('profiles').update({ locale: decision.locale }).eq('id', user.id).select('id').abortSignal(signal);
      if (signal.aborted) return { kind: 'none' };
      if (writeError) {
        console.error('[i18n] could not store the language on the profile', writeError);
        return { kind: 'none' };
      }
      if ((written ?? []).length !== 1) {
        console.error('[i18n] the language reached no profile row (refused or missing)');
        return { kind: 'none' };
      }
    } else if (decision.kind === 'restored') {
      jar.set(LOCALE_COOKIE, decision.locale, cookieOptions());
    }
    // A pending choice is settled once the profile holds it; one that was
    // another account's is left to them, and one this user has no claim to is
    // never read again for this user either way.
    if (claimed && decision.kind !== 'none') {
      jar.delete(LOCALE_PENDING_COOKIE);
    }
    return decision;
  } catch (e) {
    if (!signal.aborted) console.error('[i18n] language sync failed', e);
    return { kind: 'none' };
  }
}
