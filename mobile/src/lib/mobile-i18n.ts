import messages from './assistant-messages.json';

export type MobileLocale = keyof typeof messages;
export type MobileTranslator = (key: string, params?: Record<string, string | number>) => string;
const languages: Record<string, MobileLocale> = { en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', nl: 'nl-NL', pt: 'pt-PT' };
export function mobileLocale(value: string | undefined | null): MobileLocale { return languages[value?.toLowerCase().split(/[-_]/)[0] ?? ''] ?? 'en-US'; }
export function deviceLocale(): MobileLocale {
  try { return mobileLocale(Intl.DateTimeFormat().resolvedOptions().locale); } catch { return 'en-US'; }
}
export function mobileTranslate(locale: string, key: string, params: Record<string, string | number> = {}): string {
  const catalog = messages[mobileLocale(locale)] as Record<string, string>;
  const value = catalog[key] ?? (messages['en-US'] as Record<string, string>)[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (match, name: string) => params[name] === undefined ? match : String(params[name]));
}
export const englishMobile: MobileTranslator = (key, params) => mobileTranslate('en-US', key, params);
