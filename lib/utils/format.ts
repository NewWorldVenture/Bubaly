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
 *
 * DATES AND TIMES ONLY, and the first version of this got that wrong. It also
 * replaced U+00A0, and applied to money and numbers — where both characters are
 * meaningful rather than incidental:
 *
 *   de-DE   12,50<NBSP>$        a NON-BREAKING space, so the amount cannot be split
 *   fr-FR   1<NARROW>234<NARROW>567   U+202F is French's thousands separator
 *   pt-PT   1<NBSP>234<NBSP>567       U+00A0 is Portuguese's
 *
 * Flattening those gives an amount that can break across a line and grouping that
 * is wrong for the locale. Found only by writing a behavioural test for the
 * approval card's amount — the ratchet and the typechecker were both green over it.
 */
const normaliseClock = (text: string) => text.replace(/ /g, ' ');

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
  'EEEE, MMM d':         { weekday: 'long', month: 'short', day: 'numeric' },
  'EEEE, MMMM d':        { weekday: 'long', month: 'long', day: 'numeric' },
  // date-fns spells a locale's OWN short forms 'P' and 'pp', and these two exist for
  // the same reason: `toLocaleDateString()` with no argument renders whatever the
  // locale's own numeric date is, and eighteen sites were calling it that way to
  // follow the BROWSER. Mapping the shape lets those sites keep the rendering they
  // had while taking the family's locale instead of the machine's.
  'EEE':                 { weekday: 'short' },
  'EEEE':                { weekday: 'long' },
  'M/d/yy':              { month: 'numeric', day: 'numeric', year: '2-digit' },
  'P':                   { year: 'numeric', month: 'numeric', day: 'numeric' },
  'pp':                  { hour: 'numeric', minute: '2-digit', second: '2-digit' },
};

/**
 * A `DATE` column: a day on the family's wall calendar, with no instant in it.
 *
 * This matters the moment a zone is bound. `parseISO('2026-09-21')` gives LOCAL
 * midnight, and asking `Intl` to render that instant in another zone moves it:
 * bound to America/Los_Angeles, a `due_date` of 2026-09-21 renders **"Sun, Sep 20"**.
 * Measured, not feared — it is what `app/(app)/dashboard/family-cfo/page.tsx` would
 * have started showing for every bill, because it formats `b.due_date` and binding
 * its formatter was supposed to be the fix.
 *
 * So the rule is not "convert everything to the family's zone". It is that a
 * TIMESTAMP names an instant and must be converted, and a DATE already IS the
 * family's day and must be left alone. Converting the second is the same class of
 * error as failing to convert the first, one day in the other direction.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * How a surface wants its compact "time ago" to behave past a point.
 *
 * Ten surfaces grew their own ladder and they differ in exactly two ways, so
 * those two are the options and nothing else is:
 *
 *   absoluteAfterDays  — the Memories share attribution switches to a date after a
 *                        week; the activity feed carries on in weeks until five;
 *                        the Guardian check-in list never switches.
 *   absoluteWithYear   — and they disagree about whether that date carries a year.
 *
 * That second one used to be `absolutePattern?: string`, and a raw pattern string
 * is the wrong shape for it twice over. It is stringly typed against PATTERNS, and
 * `fmtDate` answers an UNMAPPED pattern by falling through to date-fns `format()`,
 * which has no locale — so a typo ('MMM D') would not fail anywhere, it would
 * quietly ship English month names to all eleven locales. And it put a date-fns
 * pattern in the hands of seven UI call sites, which is a formatting decision the
 * formatter owns. Every one of those callers wanted one of exactly two patterns,
 * which is what the line above already said, so it is a boolean.
 */
export type TimeAgoOptions = {
  now?: Date;
  absoluteAfterDays?: number;
  absoluteWithYear?: boolean;
};

/**
 * The ladder for a COMPACT, past-facing label, coarsest first.
 *
 * Separate from UNITS because `fmtRelative` describes a gap in either direction
 * and may reach for years; a "time ago" chip on a feed row stops at weeks and
 * hands anything older to an absolute date, which is more use than "2 mo. ago".
 */
/**
 * 'narrow' keeps en-US byte-identical to the ladders this replaced. See the note on
 * `fmtTimeAgo` before changing it — 'short' reads better in fr/pt and changes the
 * English copy on ten surfaces.
 */
const AGO_STYLE: Intl.RelativeTimeFormatStyle = 'narrow';

const AGO_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
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
  fmtTimeAgo: (value: string | Date | null | undefined, opts?: TimeAgoOptions) => string;
  fmtMoney: (cents: number, currency?: string) => string;
  fmtNumber: (value: number) => string;
};

/**
 * Every formatter, bound to one locale and, where the caller knows it, one zone.
 *
 * `t` is optional and only `fmtRelative` uses it, for the words "Today" and
 * "Tomorrow". Without it those stay English — which is the correct behaviour for
 * the non-request contexts the bare exports serve, and is why it is not required.
 *
 * `timeZone` is optional for a different reason, and the difference matters.
 *
 * Omitting it does NOT mean "no zone" — `Intl.DateTimeFormat` with no `timeZone`
 * formats in the RUNTIME's zone, and `isToday` asks the runtime which day it is.
 * In a browser that is the reader's own machine and is very probably right. On a
 * server it is the SERVER's zone, which on Vercel is UTC and is nobody's kitchen.
 *
 * Measured, not argued. A task due 09:00 Monday for a family in Los Angeles is
 * 16:00 UTC, and a server component asking for it at 18:30 Sunday their time —
 * 01:30 Monday UTC — rendered:
 *
 *   TZ=UTC                  "Today, 4:00 PM"      <- wrong day AND wrong clock
 *   TZ=America/Los_Angeles  "Tomorrow, 9:00 AM"
 *
 * `app/(app)/home/page.tsx` is the sharp case: it already resolves the family's
 * timezone and uses it to choose WHICH events are today, then rendered each one's
 * clock with a formatter that had no zone. The right events at the wrong times.
 *
 * So: pass it wherever a family's zone is known, and leave it off in a browser
 * and in the genuinely zone-less contexts (a cron, an export) where the runtime
 * zone is the best available answer.
 */
export function createFormat(
  code: LocaleCode = DEFAULT_LOCALE,
  t?: Translator,
  timeZone?: string,
): Format {
  // An invalid IANA name must not take a household page down. This mirrors the
  // choice `dayKeyInTz` in lib/services/scope.ts already documents, and it is
  // made ONCE here rather than swallowed per call, so a bad zone degrades to
  // exactly the pre-zone behaviour instead of throwing on every render.
  const zone = ((): string | undefined => {
    if (!timeZone) return undefined;
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(0));
      return timeZone;
    } catch {
      return undefined;
    }
  })();

  const dateTime = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(code, zone ? { ...options, timeZone: zone } : options);

  /**
   * The calendar day an instant falls on, in the bound zone, as `YYYY-MM-DD`.
   *
   * `en-CA` because it is the one widely-supported locale whose short date is
   * already ISO-ordered — the same trick `dayKeyInTz` uses. It cannot be imported
   * from there: `lib/services/scope.ts` opens with `import 'server-only'`, and
   * this module is on the client half too.
   */
  const dayKey = (d: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      ...(zone ? { timeZone: zone } : {}),
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);

  /**
   * The day after a day KEY — on the key, never on the instant.
   *
   * `now + 86_400_000` is the obvious way to ask and it is wrong twice a year:
   * a DST transition makes the local day 23 or 25 hours long, so adding a fixed
   * day lands on the same date or skips one. Advancing the date arithmetically is
   * exact because a calendar day always has exactly one successor.
   */
  const nextDayKey = (key: string): string => {
    const d = new Date(`${key}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

  const fmtDate = (value: string | Date | null | undefined, pattern = 'EEE, MMM d'): string => {
    if (!value) return '';
    const d = toDate(value);
    if (!d) return '';
    const options = PATTERNS[pattern];
    // An unmapped pattern keeps today's behaviour rather than guessing at one.
    if (!options) return format(d, pattern);
    // A DATE has no instant to convert, so it is rendered in no zone — see DATE_ONLY.
    if (typeof value === 'string' && DATE_ONLY.test(value)) {
      return normaliseClock(new Intl.DateTimeFormat(code, options).format(d));
    }
    return normaliseClock(dateTime(options).format(d));
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
    //
    // WHOSE today, though. With a zone bound this compares day keys in it; with
    // none it keeps date-fns and the runtime's day, which is the previous
    // behaviour exactly and is right in a browser. The two agree at offset zero
    // and disagree for a slice of every day everywhere else — which is the same
    // arithmetic `tests/family-day-not-greenwich-day.test.ts` measures for date
    // COLUMNS, arriving here through a different door.
    const todayKey = zone ? dayKey(new Date()) : null;
    // A DATE's own text is already its day key, so it is compared as written
    // rather than converted — converting it would shift the day. See DATE_ONLY.
    const here = todayKey
      ? (typeof value === 'string' && DATE_ONLY.test(value) ? value : dayKey(d))
      : null;
    const isSameDay = todayKey ? here === todayKey : isToday(d);
    const isNextDay = todayKey ? here === nextDayKey(todayKey) : isTomorrow(d);
    if (isSameDay) return t ? t('photosModule.todayAt', { time }) : `Today, ${time}`;
    if (isNextDay) return t ? t('photosModule.tomorrowAt', { time }) : `Tomorrow, ${time}`;
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

  /**
   * The compact "time ago" chip — one implementation for all of them.
   *
   * Ten surfaces had grown their own ladder under five different names
   * (`relativeTime` three times, `relTime`, `timeAgo`, `ago`, `sinceLabel`) and
   * three different wordings, every one of them ENGLISH-ONLY. None of those was
   * visible to tests/hardcoded-locales-only-go-down.test.ts, because a ladder built
   * from `'just now'` and `` `${m}m ago` `` holds no locale for a scan to find. That
   * is the defect class this replaces.
   *
   * Two deliberate choices, both of which change what a reader sees:
   *
   *   `style: 'narrow'`, `numeric: 'always'` renders en-US EXACTLY as the ladders
   *   did — "30m ago", "3h ago", "2d ago", "1w ago" — so the shipped English copy is
   *   unchanged and the five existing tests keep asserting a real contract. The cost
   *   is that narrow is terse in French and Portuguese ("-30 min" rather than
   *   "il y a 30 min"). Flipping AGO_STYLE to 'short' fixes those and changes en-US
   *   to "30 min. ago"; that is visible product copy in the majority locale, so it
   *   is the owner's call and not a formatter's.
   *
   *   Under a minute takes `numeric: 'auto'` on seconds, which gives "now", "jetzt",
   *   "maintenant", "ahora", "adesso" — a real word in all eleven locales. The
   *   ladders said "just now"; narrow/always would say "in 0s", which is worse than
   *   either. So en-US loses the "just" and gains ten correct locales.
   *
   * A FUTURE timestamp clamps to now rather than reading "in 3 minutes". A clock
   * skew of a few seconds between a phone and Postgres is ordinary, and
   * tests/marketplace-discover.test.ts already pinned that clamp.
   */
  const fmtTimeAgo = (value: string | Date | null | undefined, opts: TimeAgoOptions = {}): string => {
    if (!value) return '';
    const d = toDate(value);
    if (!d) return '';
    const now = opts.now ?? new Date();
    const gap = Math.max(0, now.getTime() - d.getTime());

    const days = gap / (24 * 3600_000);
    if (opts.absoluteAfterDays != null && days >= opts.absoluteAfterDays) {
      return fmtDate(d, opts.absoluteWithYear ? 'MMM d, yyyy' : 'MMM d');
    }
    if (gap < 60_000) {
      return new Intl.RelativeTimeFormat(code, { numeric: 'auto', style: AGO_STYLE }).format(0, 'second');
    }
    const rtf = new Intl.RelativeTimeFormat(code, { numeric: 'always', style: AGO_STYLE });
    for (const [unit, ms] of AGO_UNITS) {
      if (gap >= ms) return rtf.format(-Math.floor(gap / ms), unit);
    }
    return rtf.format(-Math.floor(gap / 60_000), 'minute');
  };

  return {
    fmtDate,
    fmtTime,
    fmtDateTime,
    fmtRelative,
    fmtTimeAgo,
    // The currency is a property of the MONEY, not of the reader's language: a US
    // family's wallet is in dollars whichever language they read. So the currency
    // stays a caller's argument (eight tables carry a `currency` column) while the
    // grouping and decimal separators follow the locale — "12,50 $" is how German
    // writes twelve and a half US dollars, and "$12.50" is not.
    fmtMoney: (cents: number, currency = 'USD') =>
      new Intl.NumberFormat(code, { style: 'currency', currency }).format(cents / 100),
    fmtNumber: (value: number) => new Intl.NumberFormat(code).format(value),
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
export const fmtTimeAgo = EN_US.fmtTimeAgo;
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
