// lib/i18n/messages.ts — catalogue loading and the translate primitive.
//
// en-US is the source of truth: its keys define the contract every other
// catalogue is checked against (tests/i18n-catalogue-parity.test.ts), and a key
// missing from a translation falls back to the English string rather than
// rendering a raw key at a visitor. A missing translation should look like an
// untranslated product, not a broken one.

import type { LocaleCode } from '@/lib/i18n/locales';

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
export type Messages = Record<string, string>;

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
 * What each locale falls back through, nearest relative first.
 *
 * Regional catalogues are OVERLAYS: es-MX carries only the keys where Mexican
 * Spanish genuinely differs from Peninsular, and inherits the rest from es-ES.
 * Without this chain an overlay would fall straight to English, so a Mexican
 * visitor would see Spanish for the handful of overridden keys and English for
 * everything else — worse than either language alone.
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
 * The catalogue for `locale`, already merged down its fallback chain so every
 * key resolves. Merging here (rather than falling back per lookup) means the
 * object handed to the client provider is complete and the client needs no
 * fallback logic of its own.
 */
export function getMessages(locale: LocaleCode): Messages {
  const catalogue = CATALOGUES[locale];
  if (!catalogue || catalogue === enUS) return enUS;

  // Nearest relative last, so it overrides the ones further away.
  const chain = [...(FALLBACK_CHAIN[locale] ?? [])].reverse();
  const merged: Messages = { ...enUS };
  for (const step of chain) Object.assign(merged, CATALOGUES[step] ?? {});
  return Object.assign(merged, catalogue);
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
export function translate(
  messages: Messages,
  key: string,
  params?: Record<string, string | number>,
): string {
  const template = messages[key] ?? SOURCE_MESSAGES[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match,
  );
}
