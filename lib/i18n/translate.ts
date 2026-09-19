// lib/i18n/translate.ts — the interpolation primitive, and NOTHING that imports
// a catalogue.
//
// This module exists for one reason: what it does NOT import.
//
// `components/i18n/locale-provider.tsx` is a `'use client'` component in the
// ROOT layout, so whatever it imports lands in a chunk every page in the
// product downloads. It used to import `translate` from `@/lib/i18n/messages`,
// which statically imports all eleven catalogue JSONs. Webpack shakes out ten
// of them, but the old `translate` ended with
//
//   messages[key] ?? SOURCE_MESSAGES[key] ?? key        // SOURCE_MESSAGES = enUS
//
// so en-US.json — 13,458 keys, 869 KB on disk — was RETAINED and inlined into
// that chunk as a single `JSON.parse('…')` blob. Measured on a real build:
// 818,132 bytes raw, 244,556 gzip, listed for `/layout`, `/(marketing)/layout`,
// `/(auth)/layout` and `/(app)/layout`, and so **62.4% of the marketing home
// page's first-load JavaScript**. A visitor reading the landing page in French
// downloaded, parsed and JSON.parsed the entire English product — wallet
// errors, the admin studio, marketplace copy — before it became interactive.
//
// `lib/i18n/scopes.ts` had already solved the same problem for the RSC PAYLOAD
// ("from 246 KB of compressed strings to about 2 KB", its own header). It could
// not touch the JS side, because the catalogue arrived through an import rather
// than through the payload. This is that second half.
//
// So: the provider imports from HERE, and the enUS-falling-back wrapper stays in
// `lib/i18n/messages.ts` for the server callers that want it, where importing
// the catalogue costs nothing a visitor pays for.

export type Messages = Record<string, string>;

/**
 * Substitute `{name}` placeholders in an already-resolved template.
 *
 * Interpolation is deliberately dumb — a single pass over `{token}` — because
 * catalogue values are our own content, never visitor input, and anything
 * cleverer (nested expressions, function calls in strings) turns a translation
 * file into an execution surface.
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match,
  );
}

/**
 * Look up `key` in `messages` and interpolate it.
 *
 * Unlike the wrapper in `lib/i18n/messages.ts`, there is no English fallback
 * here: falling back would mean holding the English catalogue, which is the
 * whole cost this module exists to avoid. The provider is handed an
 * already-merged catalogue for the active locale — merging against en-US
 * happens on the SERVER, in `getMessages` — so by the time this runs, a key the
 * catalogue has is already the right string, and a key it does not have was
 * never going to be found in the browser either.
 */
export function translate(
  messages: Messages,
  key: string,
  params?: Record<string, string | number>,
): string {
  return interpolate(messages[key] ?? key, params);
}
