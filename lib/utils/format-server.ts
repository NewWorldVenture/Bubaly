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

/**
 * `timeZone` is the family's IANA zone, and passing it is the difference between
 * the right events and the right times.
 *
 * It is a PARAMETER rather than something this function looks up, deliberately.
 * Reaching for `requireUserContext()` here would give every caller a new failure
 * mode — a page with no signed-in user would start throwing from its formatter —
 * and would bind a locale helper to the auth stack for the sake of one string.
 * The callers that have a family already resolve `ctx.active.family.timezone` a
 * few lines earlier, because they need it to choose which rows to read.
 *
 * Omitted, the formatter uses the runtime's zone, which on a server is the
 * server's. That is the right answer only where there is no family to be wrong
 * about. See the note on `createFormat`.
 */
export async function getFormat(timeZone?: string): Promise<Format> {
  const { locale, messages } = await getLocaleContext();
  return createFormat(locale.code, (key, params) => translate(messages, key, params), timeZone);
}
