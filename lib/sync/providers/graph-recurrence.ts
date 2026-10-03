// lib/sync/providers/graph-recurrence.ts — Microsoft Graph's structured
// recurrence, written as the RRULE the rest of the calendar stack speaks.
//
// Graph describes a series as `patternedRecurrence`: a `pattern` (daily,
// weekly, absoluteMonthly, relativeMonthly, absoluteYearly, relativeYearly,
// with interval, days of the week, day of month, month, ordinal index) and a
// `range` (noEnd, endDate, numbered) in a named time zone. iCalendar says the
// same things as one RRULE line, which is what `sync_calendar_events` stores
// and what the public feed publishes. Until this file the Outlook mapper wrote
// `recurrence_rule: null` for every event, so a weekly lesson mirrored as the
// one occasion it started on.
//
// The range's `recurrenceTimeZone` is a WINDOWS zone name ("Eastern Standard
// Time") on nearly every Graph tenant, and `UNTIL` on a timed series has to be
// an instant. A curated Windows→IANA table (CLDR windowsZones, the names Graph
// actually emits) turns the end date into the last second of that day in the
// series' own zone; a name the table does not know falls back to the event's
// own start zone, then to UTC, so the series still ends on the right date for
// every zone within a few hours of UTC and the limit is stated rather than
// hidden.
import { instantForLocalTime, isValidTimezone, localPartsAt } from '@/lib/time/zoned';

export type GraphRecurrence = {
  pattern?: {
    type?: string;
    interval?: number;
    month?: number;
    dayOfMonth?: number;
    daysOfWeek?: string[];
    firstDayOfWeek?: string;
    index?: string;
  } | null;
  range?: {
    type?: string;
    startDate?: string;
    endDate?: string;
    recurrenceTimeZone?: string | null;
    numberOfOccurrences?: number;
  } | null;
} | null | undefined;

const DAY: Record<string, string> = {
  sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA',
};
const INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** The Windows zone names Graph emits, as the IANA zones this runtime can compute with (CLDR windowsZones). */
const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana', 'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver', 'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Central Standard Time': 'America/Chicago', 'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina', 'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York', 'Eastern Standard Time (Mexico)': 'America/Cancun',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis', 'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
  'Paraguay Standard Time': 'America/Asuncion', 'SA Western Standard Time': 'America/La_Paz',
  'Newfoundland Standard Time': 'America/St_Johns', 'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires', 'SA Eastern Standard Time': 'America/Cayenne',
  'Greenland Standard Time': 'America/Nuuk', 'Montevideo Standard Time': 'America/Montevideo',
  'Azores Standard Time': 'Atlantic/Azores', 'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'Etc/UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris', 'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos', 'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau', 'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kyiv', 'Israel Standard Time': 'Asia/Jerusalem', 'Turkey Standard Time': 'Europe/Istanbul',
  'Arabic Standard Time': 'Asia/Baghdad', 'Arab Standard Time': 'Asia/Riyadh', 'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi', 'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
  'Azerbaijan Standard Time': 'Asia/Baku', 'Caucasus Standard Time': 'Asia/Yerevan', 'Georgian Standard Time': 'Asia/Tbilisi',
  'Afghanistan Standard Time': 'Asia/Kabul', 'West Asia Standard Time': 'Asia/Tashkent', 'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata', 'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Bishkek', 'Bangladesh Standard Time': 'Asia/Dhaka', 'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth', 'Taipei Standard Time': 'Asia/Taipei', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'West Pacific Standard Time': 'Pacific/Port_Moresby', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji', 'Tonga Standard Time': 'Pacific/Tongatapu',
};

/** An IANA zone for a Graph zone name (Windows or already IANA), or null when this runtime cannot compute in it. */
export function graphZoneToIana(zone: string | null | undefined): string | null {
  if (!zone) return null;
  const mapped = WINDOWS_TO_IANA[zone] ?? zone;
  return isValidTimezone(mapped) ? mapped : null;
}

function utcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/**
 * The RRULE for a Graph series, or null when the pattern is one this does not
 * know (the mapper then keeps `recurrence_rule` null, as it always did, rather
 * than invent a rule). `allDay` decides the shape of UNTIL: a DATE for an
 * all-day series, the last second of the end date in the series' zone
 * otherwise. `zoneHint` is the event's own start zone, the fallback when the
 * range names none this runtime knows.
 */
export function graphRecurrenceToRrule(
  recurrence: GraphRecurrence,
  opts: { allDay: boolean; zoneHint?: string | null },
): string | null {
  const pattern = recurrence?.pattern;
  if (!pattern?.type) return null;
  const parts: string[] = [];
  const days = (pattern.daysOfWeek ?? []).map((d) => DAY[d.toLowerCase()]).filter(Boolean);
  const setPos = pattern.index ? INDEX[pattern.index.toLowerCase()] : undefined;

  switch (pattern.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      break;
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY');
      if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case 'relativeMonthly':
      parts.push('FREQ=MONTHLY');
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (setPos !== undefined) parts.push(`BYSETPOS=${setPos}`);
      break;
    case 'absoluteYearly':
      parts.push('FREQ=YEARLY');
      if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
      if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case 'relativeYearly':
      parts.push('FREQ=YEARLY');
      if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (setPos !== undefined) parts.push(`BYSETPOS=${setPos}`);
      break;
    default:
      return null;
  }
  if (pattern.interval && pattern.interval > 1) parts.push(`INTERVAL=${pattern.interval}`);
  if (pattern.type === 'weekly' && pattern.firstDayOfWeek && DAY[pattern.firstDayOfWeek.toLowerCase()]) {
    parts.push(`WKST=${DAY[pattern.firstDayOfWeek.toLowerCase()]}`);
  }

  const range = recurrence?.range;
  if (range?.type === 'numbered' && range.numberOfOccurrences && range.numberOfOccurrences > 0) {
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  } else if (range?.type === 'endDate' && range.endDate && /^\d{4}-\d{2}-\d{2}/.test(range.endDate)) {
    const [y, m, d] = range.endDate.slice(0, 10).split('-').map(Number);
    if (opts.allDay) {
      parts.push(`UNTIL=${range.endDate.slice(0, 10).replace(/-/g, '')}`);
    } else {
      const zone = graphZoneToIana(range.recurrenceTimeZone) ?? graphZoneToIana(opts.zoneHint) ?? 'Etc/UTC';
      const lastMinute = instantForLocalTime(y, m, d, 23 * 60 + 59, zone) ?? new Date(Date.UTC(y, m - 1, d, 23, 59));
      parts.push(`UNTIL=${utcStamp(new Date(lastMinute.getTime() + 59_000))}`);
    }
  }
  return parts.join(';');
}

const DAY_NAME: Record<string, string> = {
  SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday',
};
const INDEX_NAME: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** The Graph shape of a series, for an event request body. */
export type GraphPatternedRecurrence = {
  pattern: Record<string, unknown>;
  range: { type: 'noEnd' | 'numbered' | 'endDate'; startDate: string; endDate?: string; numberOfOccurrences?: number };
};

/**
 * The inverse: an RRULE from a locally-owned series, as Graph's
 * `patternedRecurrence` for the body `rowToMsEvent` sends. Until this, the push
 * side sent no recurrence at all, so a weekly lesson created in Bubaly reached
 * Outlook as a single event.
 *
 * Dates in the range are read the way the body's `start` is written: a timed
 * row is sent as a UTC instant, and an all-day row stores its date as UTC
 * midnight and is sent as that date, so both read in UTC. UNTIL on a timed
 * series is an instant; the end DATE is the date of the last occurrence at or
 * before it, so `UNTIL=20261001T035959Z` on a 19:00Z series ends on 30
 * September, not 1 October. A rule Graph cannot say (hourly, several month
 * days, an ordinal it has no word for) yields null and the body carries no
 * recurrence, as before, rather than a different series.
 */
export function rruleToGraphRecurrence(
  rrule: string,
  opts: { startsAt: string; allDay: boolean },
): GraphPatternedRecurrence | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(';')) {
    const [key, value] = piece.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim());
  }
  const freq = parts.get('FREQ');
  if (!freq) return null;
  const start = new Date(opts.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  const zone = 'Etc/UTC';
  const sp = localPartsAt(start, zone);
  const startDate = `${sp.year}-${pad(sp.month)}-${pad(sp.day)}`;

  const interval = Math.max(1, Math.floor(Number(parts.get('INTERVAL') ?? '1')) || 1);
  const byday = (parts.get('BYDAY') ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const dayCodes = byday.map((d) => d.replace(/^[+-]?\d+/, ''));
  const daysOfWeek = dayCodes.map((d) => DAY_NAME[d]).filter(Boolean);
  if (daysOfWeek.length !== dayCodes.length) return null;
  const ordinals = [...new Set(byday.map((d) => d.match(/^([+-]?\d+)/)?.[1]).filter((o): o is string => !!o).map(Number))];
  if (ordinals.length > 1) return null;
  const setPos = parts.has('BYSETPOS') ? Number(parts.get('BYSETPOS')) : ordinals[0];
  const index = setPos === undefined ? undefined : INDEX_NAME[setPos];
  const single = (key: string): number | null | undefined => {
    const raw = parts.get(key);
    if (raw === undefined) return undefined;
    if (raw.includes(',')) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const monthDay = single('BYMONTHDAY');
  const month = single('BYMONTH');
  if (monthDay === null || month === null) return null;

  let pattern: Record<string, unknown>;
  switch (freq) {
    case 'DAILY':
      pattern = { type: 'daily', interval };
      break;
    case 'WEEKLY':
      pattern = {
        type: 'weekly', interval,
        daysOfWeek: daysOfWeek.length ? daysOfWeek : [WEEKDAYS[new Date(Date.UTC(sp.year, sp.month - 1, sp.day)).getUTCDay()]],
        firstDayOfWeek: DAY_NAME[parts.get('WKST') ?? 'SU'] ?? 'sunday',
      };
      break;
    case 'MONTHLY':
      if (daysOfWeek.length) {
        if (!index) return null;
        pattern = { type: 'relativeMonthly', interval, daysOfWeek, index };
      } else {
        pattern = { type: 'absoluteMonthly', interval, dayOfMonth: monthDay ?? sp.day };
      }
      break;
    case 'YEARLY':
      if (daysOfWeek.length) {
        if (!index) return null;
        pattern = { type: 'relativeYearly', interval, month: month ?? sp.month, daysOfWeek, index };
      } else {
        pattern = { type: 'absoluteYearly', interval, month: month ?? sp.month, dayOfMonth: monthDay ?? sp.day };
      }
      break;
    default:
      return null;
  }

  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) return null;
    return { pattern, range: { type: 'numbered', startDate, numberOfOccurrences: n } };
  }
  if (until) {
    const m = until.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
    if (!m) return null;
    let endDate: string;
    if (!m[4]) {
      endDate = `${m[1]}-${m[2]}-${m[3]}`;
    } else {
      // The last occurrence at or before the instant: on UNTIL's own date when
      // the series' time of day has already come by then, else the day before.
      const untilInstant = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
      const up = localPartsAt(untilInstant, zone);
      const startSeconds = sp.hour * 3600 + sp.minute * 60 + start.getUTCSeconds();
      const untilSeconds = up.hour * 3600 + up.minute * 60 + untilInstant.getUTCSeconds();
      const day = new Date(Date.UTC(up.year, up.month - 1, up.day));
      if (untilSeconds < startSeconds) day.setUTCDate(day.getUTCDate() - 1);
      endDate = day.toISOString().slice(0, 10);
    }
    return { pattern, range: { type: 'endDate', startDate, endDate } };
  }
  return { pattern, range: { type: 'noEnd', startDate } };
}
