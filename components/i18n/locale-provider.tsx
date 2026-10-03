'use client';

// components/i18n/locale-provider.tsx — the active locale, for client components.
//
// The root layout resolves the locale on the server and hands this provider the
// ALREADY-MERGED catalogue for that one locale. Two consequences worth keeping:
// the browser downloads one language rather than eleven, and the first paint is
// already correct — no English flash before a preference is read from storage.

import { createContext, useContext, useEffect, useMemo } from 'react';
import { setDbErrorTranslator } from '@/lib/supabase/errors';

import { DEFAULT_LOCALE, localeOrDefault, type Locale } from '@/lib/i18n/locales';
import { isValidTimezone } from '@/lib/time/zoned';
// From lib/i18n/translate, NOT lib/i18n/messages: this file is 'use client',
// and messages.ts imports eleven JSON catalogues at module scope. Importing
// translate from there put en-US in the client graph on every page.
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
  /**
   * The FAMILY's IANA zone (`families.timezone`), where the reader belongs to
   * one. Every family surface renders its clocks and days in it (TIME-003), so
   * a 15:00 Saturday game reads 15:00 Saturday on a parent's phone abroad, on
   * the kitchen display and in the kids view alike — and matches the server
   * page beside it, which TIME-002 already bound to the same zone. Undefined
   * where there is no family (a public or marketing page), and there the
   * reader's own zone is the right answer.
   */
  timeZone?: string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** A zone the formatters can actually use, or undefined — never a throw. */
function usableZone(timeZone: string | null | undefined): string | undefined {
  return timeZone && isValidTimezone(timeZone) ? timeZone : undefined;
}

export function LocaleProvider({
  locale,
  source,
  messages,
  timeZone,
  children,
}: {
  locale: Locale;
  source: LocaleSource;
  messages: Messages;
  /** The family's zone, when the subtree is a family surface. */
  timeZone?: string | null;
  children: React.ReactNode;
}) {
  // A scoped provider nested inside a family surface replaces the context, so
  // it inherits the zone rather than dropping it.
  const inherited = useContext(LocaleContext)?.timeZone;
  const zone = usableZone(timeZone) ?? inherited;
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      source,
      t: (key, params) => translate(messages, key, params),
      plural: (key, count, params) => pluralize(messages, locale.code, key, count, params),
      timeZone: zone,
    }),
    [locale, source, messages, zone],
  );

  // The database's classified error messages follow the reader's language
  // (I18N-011). Every provider carries the `error` namespace, and they all
  // speak the same locale, so whichever registers last is right.
  useEffect(() => { setDbErrorTranslator((key) => value.t(key)); }, [value]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Binds the family's zone into the locale context for everything below it.
 *
 * Mounted where the server already knows the family: the authenticated (app)
 * layout, and `AppProvider` (whose `family` row is the authoritative one for
 * every framed route). It keeps the parent's locale and catalogue and adds only
 * the zone, so it can sit inside `ScopedLocaleProvider` without re-reading a
 * catalogue. An unusable or missing zone leaves the parent's as it was.
 */
export function FamilyTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string | null | undefined;
  children: React.ReactNode;
}) {
  const parent = useContext(LocaleContext);
  const zone = usableZone(timeZone) ?? parent?.timeZone;
  const value = useMemo<LocaleContextValue>(
    () => parent
      ? { ...parent, timeZone: zone }
      : {
        locale: localeOrDefault(DEFAULT_LOCALE),
        source: 'default',
        t: (key, params) => translate(OUT_OF_CONTEXT_MESSAGES, key, params),
        plural: (key, count, params) => pluralize(OUT_OF_CONTEXT_MESSAGES, DEFAULT_LOCALE, key, count, params),
        timeZone: zone,
      },
    [parent, zone],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * The family's IANA zone, or undefined where the reader has no family.
 *
 * Prefer `useFormat()` / `useFamilyClock()`, which already fall back to the
 * reader's zone; this is for the rare caller that must know WHETHER a family
 * zone is bound.
 */
export function useFamilyTimeZone(): string | undefined {
  return useContext(LocaleContext)?.timeZone;
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
