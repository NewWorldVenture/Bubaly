// lib/i18n/server.ts — the request's locale, on the server.
//
// Importing next/headers makes this module server-only by construction: a
// client component that reaches for it fails at build time rather than shipping
// every catalogue to the browser.

import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE, type Locale } from '@/lib/i18n/locales';
import { getMessages, translate, type Messages } from '@/lib/i18n/messages';
import { resolveLocale, type LocaleSource } from '@/lib/i18n/resolve';

export type LocaleContext = {
  locale: Locale;
  source: LocaleSource;
  messages: Messages;
};

/**
 * Resolve the locale for the current request and load its catalogue.
 *
 * The geo header is Vercel's `x-vercel-ip-country`, set at the edge on every
 * request; `x-country` is accepted too so the value can be forced in local
 * development and in E2E without standing up a proxy.
 *
 * NOT memoised per request, deliberately. React's `cache()` would be the tool,
 * and this project is on React 18.3, which does not export it. What is left to
 * repeat per call is cheap: `cookies()` and `headers()` read the request store
 * Next has already built, and `resolveLocale` looks at three short strings.
 * The expensive half — assembling the catalogue — is memoised per LOCALE in
 * `getMessages`, which is where the cost actually was.
 */
export async function getLocaleContext(): Promise<LocaleContext> {
  const signals = await requestSignals();

  const { locale, source } = resolveLocale(signals);

  return { locale, source, messages: getMessages(locale.code) };
}

/**
 * The locale signals for the current request, or NONE when there is no request.
 *
 * `cookies()` and `headers()` throw outside a request scope, and this module is
 * no longer reached only from rendering: server actions carry their own failure
 * copy now, and the same functions are called from cron handlers and background
 * jobs, which have no request and no user to have a language preference. There,
 * falling back to the default locale is the correct answer — a nightly routine
 * writes in the source language — and throwing would take down a job over a
 * message nobody reads.
 *
 * Deliberately narrow: only the two request accessors are guarded, so a real
 * failure anywhere below still surfaces.
 */
async function requestSignals(): Promise<Parameters<typeof resolveLocale>[0]> {
  try {
    const [jar, head] = await Promise.all([cookies(), headers()]);
    return {
      cookie: jar.get(LOCALE_COOKIE)?.value,
      country: head.get('x-vercel-ip-country') ?? head.get('x-country'),
      acceptLanguage: head.get('accept-language'),
    };
  } catch {
    return {};
  }
}

/**
 * Server-component translator:
 *
 *   const t = await getTranslations();
 *   <h1>{t('auth.login.title')}</h1>
 *
 * Returns the English string for any key a translation hasn't reached yet, so a
 * lagging catalogue shows an untranslated product rather than a broken one.
 */
export async function getTranslations() {
  const { messages } = await getLocaleContext();
  return (key: string, params?: Record<string, string | number>) =>
    translate(messages, key, params);
}
