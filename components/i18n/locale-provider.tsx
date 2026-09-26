'use client';

// components/i18n/locale-provider.tsx — the active locale, for client components.
//
// The root layout resolves the locale on the server and hands this provider the
// ALREADY-MERGED catalogue for that one locale. Two consequences worth keeping:
// the browser downloads one language rather than eleven, and the first paint is
// already correct — no English flash before a preference is read from storage.

import { createContext, useContext, useMemo } from 'react';

import { DEFAULT_LOCALE, localeOrDefault, type Locale } from '@/lib/i18n/locales';
import { pluralize, translate, type Messages } from '@/lib/i18n/translate';
import type { LocaleSource } from '@/lib/i18n/resolve';

type LocaleContextValue = {
  locale: Locale;
  /** Which signal chose this locale — the picker uses it to distinguish a
   *  detected default from a choice the visitor actually made. */
  source: LocaleSource;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** A counted phrase, resolved through the locale's own CLDR plural rules. */
  plural: (key: string, count: number, params?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  source,
  messages,
  children,
}: {
  locale: Locale;
  source: LocaleSource;
  messages: Messages;
  children: React.ReactNode;
}) {
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      source,
      t: (key, params) => translate(messages, key, params),
      plural: (key, count, params) => pluralize(messages, locale.code, key, count, params),
    }),
    [locale, source, messages],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * The only strings rendered OUTSIDE every provider.
 *
 * `app/global-error.tsx` renders its own <html>, so it sits above the root
 * layout and above LocaleProvider, and it calls `useTranslations()` all the
 * same. Before the catalogue left this chunk, the English fallback inside
 * `translate` covered it by accident — at a cost of 244 KB gzip on every page
 * in the product, to serve four strings on a screen almost nobody sees.
 *
 * So they are inlined. Everywhere else the fallback was already unreachable:
 * the (app) group ships `namespaces="all"`, and
 * `tests/i18n-client-scope.test.ts` fails the build if a scoped surface's
 * client components reach a key outside its scope — so a scoped provider
 * always already holds the key it is asked for.
 */
const OUT_OF_CONTEXT_MESSAGES: Messages = {
  'globalError.somethingWentWrong': 'Something went wrong',
  'globalError.bubalyHitAnUnexpectedErrorYour':
    'Bubaly hit an unexpected error. Your data is safe. Try again, or reload the app.',
  'globalError.tryAgain': 'Try again',
  'globalError.reloadBubaly': 'Reload Bubaly',
};

/**
 * Translate inside a client component.
 *
 * Falls back rather than throwing when used outside the provider: a component
 * rendered in isolation (a test, a storybook-style harness) should still render
 * readable text instead of exploding. `translate` returns the KEY for anything
 * not in the map above, which is the honest answer — the browser no longer
 * carries the English catalogue, so there is nothing else to find.
 */
export function useTranslations() {
  const ctx = useContext(LocaleContext);
  if (ctx) return ctx.t;
  return (key: string, params?: Record<string, string | number>) =>
    translate(OUT_OF_CONTEXT_MESSAGES, key, params);
}

/**
 * Pluralise inside a client component.
 *
 *   const plural = usePlural();
 *   plural('declutter.missionsDone', s.missions_done)
 *
 * Outside the provider this falls back the same way `useTranslations` does, and
 * for the same reason — except that the four inlined messages hold no counted
 * phrase, so the honest answer there is the key.
 */
export function usePlural() {
  const ctx = useContext(LocaleContext);
  if (ctx) return ctx.plural;
  return (key: string, count: number, params?: Record<string, string | number>) =>
    pluralize(OUT_OF_CONTEXT_MESSAGES, DEFAULT_LOCALE, key, count, params);
}

/** The active locale, for formatting dates, numbers and currency. */
export function useLocale(): Locale {
  return useContext(LocaleContext)?.locale ?? localeOrDefault(DEFAULT_LOCALE);
}

/** Which signal picked the active locale. */
export function useLocaleSource(): LocaleSource {
  return useContext(LocaleContext)?.source ?? 'default';
}
