import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { DEFAULT_LOCALE, localeOrDefault } from '@/lib/i18n/locales';

// Render a client component the way the APP renders it: inside a LocaleProvider
// holding a real catalogue.
//
// These tests used to call `renderToStaticMarkup` on a bare element and assert
// on the English that came out. That worked by accident. `useTranslations()`
// outside a provider fell through to `translate`'s English fallback, and that
// fallback held the whole en-US catalogue — 13,458 keys — which is precisely why
// the catalogue could not tree-shake out of the root layout's client chunk and
// shipped 244 KB gzip to every visitor (see `lib/i18n/translate.ts`).
//
// With the fallback gone the assertions have to say where the strings come
// from, and the honest answer is the provider. A component rendered outside
// every provider is a configuration the product never ships: `app/layout.tsx`
// wraps the entire tree, so in the real app the only thing above LocaleProvider
// is `app/global-error.tsx`, which has its four strings inlined for exactly
// that reason.
//
// Importing the catalogue HERE costs nothing: this runs in Node, not in a
// browser bundle.
export function renderTranslated(node: ReactElement, locale = DEFAULT_LOCALE): string {
  return renderToStaticMarkup(
    <LocaleProvider locale={localeOrDefault(locale)} source="default" messages={getMessages(locale)}>
      {node}
    </LocaleProvider>,
  );
}

/**
 * A LocaleProvider context value holding the real English catalogue, for
 * harnesses that invoke a component as a plain FUNCTION rather than rendering
 * it — there is no React dispatcher there, so `useContext` has to be stubbed.
 *
 * Those harnesses used to stub it as `undefined` and rely on `useTranslations`
 * falling through to the English catalogue inside `translate`. That fallback is
 * gone (it was 244 KB gzip on every page; see `lib/i18n/translate.ts`), and the
 * reasoning behind the stub — "what a user would see if the provider were ever
 * missing" — does not hold either: `app/layout.tsx` wraps the whole tree, so
 * the provider is never missing in the product. Handing back a real context
 * value is both closer to the app and keeps the assertions written against the
 * English words a person actually reads.
 */
export function localeContextValue() {
  const messages = getMessages(DEFAULT_LOCALE);
  return {
    locale: localeOrDefault(DEFAULT_LOCALE),
    source: 'default' as const,
    t: (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
}
