// lib/i18n/messages.ts — catalogue loading and the translate primitive.
//
// en-US is the source of truth: its keys define the contract every other
// catalogue is held to, and a key missing from a translation falls back to the
// English string rather than rendering a raw key at a visitor. A missing
// translation should look like an untranslated product, not a broken one.
//
// THE TEST THAT LINE NAMED DOES NOT EXIST. It said the contract was checked
// against a file called i18n-catalogue-parity.test.ts, and there has never been
// one by that name under tests/ — lib/i18n/messages/README.md carried the same
// dead pointer and has been corrected with it. (Neither file spells that name
// with its directory any more, because the guard below treats a `tests/…` path
// as a promise that the file is there.) What exists is
// tests/i18n-catalogue-integrity.test.ts, which checks entity, escape,
// placeholder, orphan and script hygiene but asserts nothing about coverage, and
// tests/an-empty-locale-says-it-is-a-placeholder.test.ts, which is where the key
// contract and the PLACEHOLDER_LOCALES declaration below are actually enforced.
// A confident pointer at a test nobody wrote is how four catalogues stayed empty
// while the code around them said otherwise (I18N-009).
//
// That fallback lives in getMessages() below — `{ ...enUS }` with the locale's
// overlay assigned over it — and NOT in `translate` any more. `translate` moved
// to lib/i18n/translate.ts, which imports no catalogue, because a client
// component importing it from here made en-US a live reference in the browser
// graph: 821.5 KB raw / 245.8 KB gzip on every page, measured on served HTML.
// It is re-exported here so every existing caller is unchanged, and it is
// unchanged for them in behaviour too: the map this module hands out is
// already complete, so `messages[key] ?? SOURCE_MESSAGES[key]` and
// `messages[key]` cannot differ.

import type { LocaleCode } from '@/lib/i18n/locales';
import { translate, type Messages } from '@/lib/i18n/translate';

import deDE from '@/lib/i18n/messages/de-DE.json';
import enGB from '@/lib/i18n/messages/en-GB.json';
import enUS from '@/lib/i18n/messages/en-US.json';
import esES from '@/lib/i18n/messages/es-ES.json';
import esMX from '@/lib/i18n/messages/es-MX.json';
import esUS from '@/lib/i18n/messages/es-US.json';
import frCA from '@/lib/i18n/messages/fr-CA.json';
import frFR from '@/lib/i18n/messages/fr-FR.json';
import itIT from '@/lib/i18n/messages/it-IT.json';
import nlNL from '@/lib/i18n/messages/nl-NL.json';
import ptPT from '@/lib/i18n/messages/pt-PT.json';

/** The English catalogue's keys are the contract; every other catalogue is a
 *  partial of it, so a translation can lag without breaking the build. */
export type MessageKey = keyof typeof enUS;
export { translate };
export type { Messages };

const CATALOGUES: Record<LocaleCode, Messages> = {
  'en-US': enUS,
  'en-GB': enGB,
  'de-DE': deDE,
  'es-ES': esES,
  'es-MX': esMX,
  'es-US': esUS,
  'fr-FR': frFR,
  'fr-CA': frCA,
  'it-IT': itIT,
  'nl-NL': nlNL,
  'pt-PT': ptPT,
};

export const SOURCE_MESSAGES: Messages = enUS;

/**
 * The locales whose catalogue is still EMPTY, declared rather than discovered.
 *
 * Four of the eleven — en-GB, es-MX, es-US, fr-CA — are literally `{}`, three
 * bytes each, against 13,806 keys in each of the other seven. Merged down the
 * chain below they come out byte-identical to what they inherit: every value an
 * en-GB reader sees is en-US's, every value an es-MX reader sees is es-ES's.
 * Nothing renders a raw key, no page is blank, and a visitor still gets their
 * own region's dates, numbers and currency through `Intl` — the locale CODE
 * drives that, not the catalogue. So this is a content gap, not a broken
 * feature, and it is why these four keep their place in the picker.
 *
 * Empty is a legitimate state for an OVERLAY to be in, and filling them with
 * invented differences would make the product worse rather than more localised.
 * What was NOT legitimate is that nothing said so — lib/i18n/locales.ts asserted
 * that "the regional choice carries real meaning: Latin America reads es-MX
 * rather than Spain's es-ES" about a file containing nothing, and README.md said
 * the opposite three directories away. The comment has been corrected; this
 * declaration is what keeps it correct.
 *
 * It is checked BOTH WAYS by tests/an-empty-locale-says-it-is-a-placeholder.test.ts:
 * every locale named here must really be empty, and every locale NOT named here
 * must really carry the whole English key set. So a catalogue cannot be quietly
 * shipped empty, and an overlay cannot be filled in without this list being
 * updated to say it was.
 */
export const PLACEHOLDER_LOCALES: readonly LocaleCode[] = ['en-GB', 'es-MX', 'es-US', 'fr-CA'];

/**
 * What each locale falls back through, nearest relative first.
 *
 * Regional catalogues are OVERLAYS: es-MX is meant to carry only the keys where
 * Mexican Spanish genuinely differs from Peninsular, and to inherit the rest
 * from es-ES. Without this chain an overlay would fall straight to English, so a
 * Mexican visitor would see Spanish for the handful of overridden keys and
 * English for everything else — worse than either language alone.
 *
 * "The handful" is currently NONE: all four overlays are empty, which
 * PLACEHOLDER_LOCALES above states and a test holds. The chain is what makes
 * that harmless rather than invisible.
 *
 * en-US is the root of every chain and is therefore never listed.
 */
const FALLBACK_CHAIN: Partial<Record<LocaleCode, LocaleCode[]>> = {
  'es-MX': ['es-ES'],
  // Spanish as written for the United States sits closer to Mexican usage than
  // to Peninsular, so it inherits through es-MX.
  'es-US': ['es-MX', 'es-ES'],
  'fr-CA': ['fr-FR'],
};

/**
 * The locales `locale` reads from, nearest first and including itself.
 *
 * Exported because the catalogue is not the only thing a regional locale
 * inherits. The AEO knowledge base is stored per locale in the database, and it
 * has exactly the same problem an overlay catalogue has: a fr-CA reader whose
 * chrome resolves through fr-FR must read the fr-FR answers too, or the page is
 * French around a section that is not there at all. Both callers deriving the
 * chain from this one table is what keeps them from drifting apart.
 *
 * A locale we do not ship gets a chain of just itself, which is the honest
 * answer: we know nothing about what it should inherit.
 */
export function localeFallbackChain(locale: string): string[] {
  return [locale, ...(FALLBACK_CHAIN[locale as LocaleCode] ?? [])];
}

/**
 * The catalogue for `locale`, already merged down its fallback chain so every
 * key resolves. Merging here (rather than falling back per lookup) means the
 * object handed to the client provider is complete and the client needs no
 * fallback logic of its own.
 */
const MERGED = new Map<LocaleCode, Messages>();

export function getMessages(locale: LocaleCode): Messages {
  const catalogue = CATALOGUES[locale];
  if (!catalogue || catalogue === enUS) return enUS;

  // Built ONCE per locale. Every input is a static import, so the result cannot
  // differ between calls — and the cost is not small: the merge spreads all
  // 9,983 English keys and then assigns as many again over them, roughly 600 KB
  // of strings per call. That was affordable when `getTranslations()` was
  // called by a handful of page components. It is not now that every server
  // action and route handler words its own failures: one render can ask for the
  // catalogue dozens of times, and each ask was allocating the whole thing.
  const cached = MERGED.get(locale);
  if (cached) return cached;

  // Nearest relative last, so it overrides the ones further away.
  const chain = [...(FALLBACK_CHAIN[locale] ?? [])].reverse();
  const merged: Messages = { ...enUS };
  for (const step of chain) Object.assign(merged, CATALOGUES[step] ?? {});
  Object.assign(merged, catalogue);
  MERGED.set(locale, merged);
  return merged;
}

/** The raw, unmerged catalogue — for parity tests that need to see real gaps. */
export function getRawMessages(locale: LocaleCode): Messages {
  return CATALOGUES[locale] ?? {};
}

/**
 * Look up `key` and substitute `{name}` placeholders.
 *
 * Interpolation is deliberately dumb — a single pass over `{token}` — because
 * catalogue values are our own content, never visitor input, and anything
 * cleverer (nested expressions, function calls in strings) turns a translation
 * file into an execution surface.
 */
