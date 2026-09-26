// lib/i18n/translate.ts — the lookup, with NO catalogue behind it.
//
// This module exists to be importable from a CLIENT component without dragging
// eleven JSON catalogues into the browser, and that is its whole reason. Before
// it, `components/i18n/locale-provider.tsx` imported `translate` from
// `lib/i18n/messages.ts`, which imports every catalogue at module scope, so
// en-US was a live reference in the client graph and shipped to every page:
// `.next/static/chunks/19933-*.js`, 821.5 KB raw / 245.8 KB gzip, measured on
// SERVED HTML rather than a manifest, present on /, /cookies, /privacy, /login
// and /blog. Ten of the eleven catalogues tree-shook out; English did not.
//
// The sting was what it undid. `lib/i18n/scopes.ts` narrows /cookies to a few
// dozen of the catalogue's values — and then that chunk delivered all of it to
// the same page.
//
// WHAT CHANGED, STATED EXACTLY. `translate` used to read
//
//     messages[key] ?? SOURCE_MESSAGES[key] ?? key
//
// and now reads `messages[key] ?? key`. The middle term was the catalogue
// import. For every caller that passes a COMPLETE message map the two are
// identical, and that is every caller that matters:
//
//   • the server: `getTranslations()` passes `getMessages(locale)`, which
//     builds `{ ...enUS }` and assigns the locale's overlay over it, so every
//     key en-US has is present whatever the locale;
//   • `ScopedLocaleProvider namespaces="all"` (the authenticated app and
//     onboarding): the same complete map;
//   • the five scoped public surfaces: `scopeMessages` filters that complete
//     map, and tests/i18n-client-scope.test.ts proves the filter keeps every
//     key those surfaces ask for — for literal calls AND for expression-keyed
//     ones, which is the half that took three passes to see.
//
// The one place the two differ is a component rendered with NO provider at all.
// There `useTranslations()` used to return English through the fallback and now
// returns the key. That is deliberate: a component with no provider was already
// rendering untranslated text in every locale, so the fallback was hiding a
// missing provider rather than serving a reader. `app/global-error.tsx` is the
// one production case and it now carries its own English map.
export type Messages = Record<string, string>;

/**
 * Look up `key` and substitute `{name}` placeholders.
 *
 * Interpolation is deliberately dumb — a single pass over `{token}` — because
 * catalogue values are our own content, never visitor input, and anything
 * cleverer (nested expressions, function calls in strings) turns a translation
 * file into an execution surface.
 */
export function translate(
  messages: Messages,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = messages[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match,
  );
}
