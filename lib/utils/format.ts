// Small, dependency-light formatting helpers shared across the app.
//
// LOCALISED. Bubaly ships eleven locales and every date, time and money value in
// this module rendered in US English regardless of which one the family chose:
// `format(d, 'EEE, MMM d')` gives "Tue, Jul 14" to a German family who expect
// "Di., 14. Juli", `'h:mm a'` gives 12-hour AM/PM to locales that use a 24-hour
// clock, `fmtRelative` said "Today," in hardcoded English, and `fmtMoney` pinned
// `new Intl.NumberFormat('en-US')` at module scope. lib/i18n/locales.ts says in its
// own header that the unit is a full locale because "a family in Mexico and a
// family in Spain both read Spanish but expect different dates, currency and
// vocabulary" — and nothing consumed it for either.
//
// `createFormat(code)` binds every helper to one locale. The bare exports below are
// that, bound to en-US, and they are NOT a leftover: crons, CSV exports and the
// prompts sent to a model have no reader with a language preference, and the source
// language is the right answer there. `useFormat()` (client) and `getFormat()`
// (server) are what a rendered surface should use.
//
// Built on `Intl`, not on date-fns with a locale, for a reason that matters: a
// pattern like 'EEE, MMM d' hardcodes the ORDER as well as the names, so date-fns
// with a German locale gives "Di., Juli 14" — German names in American order.
// `Intl.DateTimeFormat` gets both right, and costs no bundle. date-fns remains the
// fallback for any pattern the map below does not recognise.
//
// HARDENED (kept): date-fns `format`/`isToday`/`formatDistanceToNow` all THROW
// (`RangeError: Invalid time value`) on an Invalid Date — which let a single
// malformed timestamp in the data crash an entire route (the Kitchen Display kiosk
// hit exactly this in prod). `parseISO` also rejects Postgres-style timestamps
// ("2026-07-14 22:00:00+00", space instead of "T") that arrive via SQL-editor seeds
// and non-PostgREST paths. Every helper here parses tolerantly and returns ''
// instead of throwing — a bad date renders blank, never a crash.
import { format, isToday, isTomorrow, parseISO } from 'date-fns';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

/** Tolerant parse: ISO first, then native Date (accepts Postgres "YYYY-MM-DD HH:mm:ss+TZ"). */
function toDate(value: string | Date): Date | null {
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (!Number.isNaN(d.getTime())) return d;
  if (typeof value === 'string') {
    const fallback = new Date(value);
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }
  return null;
}

/**
 * ICU 72 and later put U+202F (NARROW NO-BREAK SPACE) before AM/PM, where earlier
 * versions used an ordinary space. Normalised so this module's output does not
 * change shape when the runtime's ICU is upgraded under it — and so a test may
 * assert "9:05 AM" and mean it.
 */
const normalise = (text: string) => text.replace(/[  ]/g, ' ');

/**
 * The date-fns patterns this app actually passes to `fmtDate`, mapped to the Intl
 * options that mean the same thing.
 *
 * A closed vocabulary on purpose: 41 of 192 call sites pass a pattern and between
 * them they use these nine. Anything else falls through to date-fns, so an
 * unmapped pattern renders as it does today rather than rendering wrong — and
 * tests/the-shared-formatter-follows-the-locale.test.ts reads every pattern the app
 * passes out of the source and requires each to be in here, so a tenth added next
 * month is a failing test rather than a silently un-localised date.
 */
const PATTERNS: Record<string, Intl.DateTimeFormatOptions> = {
  'EEE, MMM d':          { weekday: 'short', month: 'short', day: 'numeric' },
  'MMM d':               { month: 'short', day: 'numeric' },
  'MMM d, yyyy':         { month: 'short', day: 'numeric', year: 'numeric' },
  'MMMM d, yyyy':        { month: 'long', day: 'numeric', year: 'numeric' },
  'h:mm a':              { hour: 'numeric', minute: '2-digit' },
  'hh:mm a':             { hour: '2-digit', minute: '2-digit' },
  'hh:mm:ss a':          { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  'MMM d, h:mm a':       { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  'MMM d · h:mm a':      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  'MMM d, yyyy h:mm a':  { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  "EEE, MMM d 'at' h:mm a": { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

/** Every pattern the map knows — read by the guard that keeps it complete. */
export const KNOWN_DATE_PATTERNS = Object.keys(PATTERNS);

/** The ordered units `fmtRelative` will describe a gap in. */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** A translator, in the shape `useTranslations()` and `getTranslations()` return. */
type Translator = (key: string, params?: Record<string, string | number>) => string;

export type Format = {
  fmtDate: (value: string | Date | null | undefined, pattern?: string) => string;
  fmtTime: (value: string | Date | null | undefined) => string;
  fmtDateTime: (value: string | Date | null | undefined) => string;
  fmtRelative: (value: string | Date | null | undefined) => string;
  fmtMoney: (cents: number, currency?: string) => string;
  fmtNumber: (value: number) => string;
};

/**
 * Every formatter, bound to one locale.
 *
 * `t` is optional and only `fmtRelative` uses it, for the words "Today" and
 * "Tomorrow". Without it those stay English — which is the correct behaviour for
 * the non-request contexts the bare exports serve, and is why it is not required.
 */
export function createFormat(code: LocaleCode = DEFAULT_LOCALE, t?: Translator): Format {
  const dateTime = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(code, options);

  const fmtDate = (value: string | Date | null | undefined, pattern = 'EEE, MMM d'): string => {
    if (!value) return '';
    const d = toDate(value);
    if (!d) return '';
    const options = PATTERNS[pattern];
    // An unmapped pattern keeps today's behaviour rather than guessing at one.
    if (!options) return format(d, pattern);
    return normalise(dateTime(options).format(d));
  };

  const fmtTime = (value: string | Date | null | undefined): string =>
    fmtDate(value, 'h:mm a');

  const fmtDateTime = (value: string | Date | null | undefined): string =>
    fmtDate(value, "EEE, MMM d 'at' h:mm a");

  const fmtRelative = (value: string | Date | null | undefined): string => {
    if (!value) return '';
    const d = toDate(value);
    if (!d) return '';
    const time = fmtTime(d);
    // Today and Tomorrow read better than "in 4 hours" and are what the surface
    // showed before; only the words were English. The keys already existed.
    if (isToday(d)) return t ? t('photosModule.todayAt', { time }) : `Today, ${time}`;
    if (isTomorrow(d)) return t ? t('photosModule.tomorrowAt', { time }) : `Tomorrow, ${time}`;
    // Intl.RelativeTimeFormat rather than date-fns formatDistanceToNow, which has
    // no locale here and would say "about 2 hours ago" in English to everyone.
    const gap = d.getTime() - Date.now();
    const size = Math.abs(gap);
    for (const [unit, ms] of UNITS) {
      if (size >= ms) {
        const amount = Math.round(gap / ms);
        return new Intl.RelativeTimeFormat(code, { numeric: 'auto' }).format(amount, unit);
      }
    }
    return new Intl.RelativeTimeFormat(code, { numeric: 'auto' }).format(0, 'minute');
  };

  return {
    fmtDate,
    fmtTime,
    fmtDateTime,
    fmtRelative,
    // The currency is a property of the MONEY, not of the reader's language: a US
    // family's wallet is in dollars whichever language they read. So the currency
    // stays a caller's argument (eight tables carry a `currency` column) while the
    // grouping and decimal separators follow the locale — "12,50 $" is how German
    // writes twelve and a half US dollars, and "$12.50" is not.
    fmtMoney: (cents: number, currency = 'USD') =>
      normalise(new Intl.NumberFormat(code, { style: 'currency', currency }).format(cents / 100)),
    fmtNumber: (value: number) => normalise(new Intl.NumberFormat(code).format(value)),
  };
}

/**
 * The en-US binding.
 *
 * Correct for anything with no reader whose language we know — crons, exports, the
 * text of a prompt — and the wrong choice for a rendered surface, which should take
 * `useFormat()` or `await getFormat()` instead.
 */
const EN_US = createFormat(DEFAULT_LOCALE);

export const fmtDate = EN_US.fmtDate;
export const fmtTime = EN_US.fmtTime;
export const fmtDateTime = EN_US.fmtDateTime;
export const fmtRelative = EN_US.fmtRelative;
export const fmtMoney = EN_US.fmtMoney;
export const fmtNumber = EN_US.fmtNumber;

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

// Null-safe first-name/label. `family_members.display_name` is nullable in the
// DB but typed `string`, so a raw `name.split(' ')[0]` throws during render for
// a member with a null name — which white-screened the Kitchen Display (the
// "Reconnecting…" loop). Every UI site must go through this instead.
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'Member';
}
