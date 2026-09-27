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

/**
 * Which plural form a language uses for `count`.
 *
 * ── Why a language cannot be pluralised by a suffix ─────────────────────────
 *
 * 219 call sites in this codebase spell a plural as
 *
 *   `${n} mission${n === 1 ? '' : 's'}`
 *
 * which is not English being interpolated into a template — it is English
 * GRAMMAR compiled into the source, and no translation can undo it. Three ways
 * it is wrong once the string leaves English:
 *
 *   - The BOUNDARY moves. French puts 0 in the singular (`0 mission`), English
 *     does not (`0 missions`). So even a two-form language disagrees about which
 *     numbers take which form.
 *   - The COUNT of forms changes. Polish and Russian take three or four
 *     (`1 plik`, `2 pliki`, `5 plików`); Arabic takes six. A ternary cannot
 *     express what it has no branches for.
 *   - The word itself INFLECTS rather than gaining a letter. German
 *     `1 Aufgabe` / `2 Aufgaben`, Italian `1 missione` / `2 missioni`. There is
 *     no suffix to append, so a translator handed `mission` + `s` has nowhere to
 *     put the answer.
 *
 * `Intl.PluralRules` is the CLDR table for exactly this, built into the runtime,
 * and costs nothing to ship. This returns its category, and the catalogue holds
 * one key per category: `missions.count.one`, `missions.count.other`, and for a
 * language that needs them `zero`, `two`, `few`, `many`.
 *
 * Two failure modes, and they are NOT the same one — measured, because the first
 * draft of this comment got it wrong and the test caught it:
 *
 *   - A WELL-FORMED tag the runtime has no data for (`zz`, `xx-YY`) does not
 *     throw. `Intl` resolves it to the runtime's default, and
 *     `resolvedOptions().locale` reports `en-US`. So an unknown language quietly
 *     gets ENGLISH plural rules, which is wrong for German and right for nothing
 *     in particular — the protection against that is `LOCALES`, not this
 *     function, and tests/a-plural-is-not-a-suffix.test.ts asserts every locale
 *     this product ships really has data.
 *   - A MALFORMED tag (`''`, `'en_US'` with an underscore, `'!!'`) throws
 *     `RangeError`. That is what the catch is for, and `other` is the answer
 *     because it is the one category every language has — so the catalogue is
 *     never asked for a key CLDR would not name, and a caller with a broken
 *     locale renders text rather than a bare key.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export function pluralCategory(locale: string, count: number): PluralCategory {
  if (!Number.isFinite(count)) return 'other';
  try {
    return new Intl.PluralRules(locale).select(count) as PluralCategory;
  } catch {
    return 'other';
  }
}

/**
 * Resolve a counted phrase.
 *
 * The catalogue is asked for `<key>.<category>` and then, if the language does
 * not distinguish that category or the translation has not reached it yet,
 * `<key>.other`. `other` is required of every key: it is the only category CLDR
 * guarantees, and it is what a language with one form uses for everything.
 *
 * `{count}` is supplied automatically, formatted for the locale, because a
 * number rendered to a person is locale-dependent too — `1.234` in de-DE is
 * `1,234` in en-US, and a phrase that translates its words while leaving its
 * digits in American order is only half translated. A caller may override
 * `count` (or add any other placeholder) through `params`; an explicit value is
 * passed through verbatim, since a caller formatting it themselves has a reason.
 *
 * `fallback` exists for the SERVER only, and is the same split this whole module
 * is about: `lib/i18n/messages.ts` passes the English catalogue so a lagging
 * translation shows English rather than a key, and client code passes nothing,
 * because holding that catalogue in the browser is the 244 KB the header above
 * describes. The whole chain is tried in the active locale before any of it is
 * tried in English — a language that has `other` but not `many` should use its
 * own `other`, not English's `many`.
 */
export function pluralize(
  messages: Messages,
  locale: string,
  key: string,
  count: number,
  params?: Record<string, string | number>,
  fallback?: Messages,
): string {
  const category = pluralCategory(locale, count);
  const template = messages[`${key}.${category}`] ?? messages[`${key}.other`]
    ?? fallback?.[`${key}.${category}`] ?? fallback?.[`${key}.other`];
  // No `other` form means the key is absent, not that the phrase has no plural.
  // Returning the bare key is what every other lookup in this file does, and it
  // is what tests/i18n-catalogue-integrity.test.ts is there to prevent shipping.
  if (template === undefined) return key;
  let formatted: string | number = count;
  try {
    formatted = new Intl.NumberFormat(locale).format(count);
  } catch {
    formatted = count;
  }
  return interpolate(template, { count: formatted, ...params });
}
