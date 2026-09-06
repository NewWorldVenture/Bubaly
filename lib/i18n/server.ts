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
 */
export async function getLocaleContext(): Promise<LocaleContext> {
  const [jar, head] = await Promise.all([cookies(), headers()]);

  const { locale, source } = resolveLocale({
    cookie: jar.get(LOCALE_COOKIE)?.value,
    country: head.get('x-vercel-ip-country') ?? head.get('x-country'),
    acceptLanguage: head.get('accept-language'),
  });

  return { locale, source, messages: getMessages(locale.code) };
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
