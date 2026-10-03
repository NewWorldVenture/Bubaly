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
import { instantForLocalTime, isValidTimezone } from '@/lib/time/zoned';

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
