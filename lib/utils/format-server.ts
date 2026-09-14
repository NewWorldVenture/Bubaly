// The shared formatters, bound to the request's locale.
//
// Same shape as `getTranslations()` in lib/i18n/server.ts, deliberately:
//
//   const t = await getTranslations();
//   const { fmtDate, fmtMoney } = await getFormat();
//
// It is server-only by construction, because lib/i18n/server.ts imports
// next/headers — a client component that reaches for this fails at build time
// rather than shipping every catalogue to the browser. `useFormat()` is the client
// half.
//
// Outside a request — a cron, a background job — `getLocaleContext()` already falls
// back to the default locale rather than throwing, so this is safe to call there
// too and returns the en-US binding, which is the right answer for a reader who
// does not exist.
import { getLocaleContext } from '@/lib/i18n/server';
import { translate } from '@/lib/i18n/messages';
import { createFormat, type Format } from '@/lib/utils/format';

export async function getFormat(): Promise<Format> {
  const { locale, messages } = await getLocaleContext();
  return createFormat(locale.code, (key, params) => translate(messages, key, params));
}
