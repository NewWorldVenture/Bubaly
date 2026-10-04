// lib/sync/ics.ts
//
// RFC 5545 (iCalendar) generation + a pragmatic parser.
import { instantForLocalTime, isValidTimezone } from '@/lib/time/zoned';
// This is the one piece of
// cross-provider sync that works with NO OAuth and no provider cooperation: any
// calendar app (Apple Calendar, Outlook, Google "from URL", Alexa) can subscribe
// to a generated ICS feed URL and receive bubaly events. Generation is pure
// and deterministic (timestamps are passed in), so it is fully unit-testable.

export type IcsEvent = {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO 8601 string. */
  startsAt: string;
  /** ISO 8601 string; for all-day, may be the exclusive end date. */
  endsAt?: string | null;
  allDay?: boolean;
  /** Raw RFC 5545 RRULE value WITHOUT the "RRULE:" prefix, e.g. "FREQ=WEEKLY". */
  recurrenceRule?: string | null;
  /** Last modification ISO timestamp (drives DTSTAMP / LAST-MODIFIED). */
  updatedAt?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  /**
   * RECURRENCE-ID as an ISO instant: this VEVENT replaces ONE occurrence of
   * the recurring series that shares its UID (a rescheduled or cancelled
   * instance). Null for a stand-alone event or a series master. Two VEVENTs with
   * one UID are the rule for any calendar with a moved occurrence, so a reader
   * that keys by UID alone must look here before letting one overwrite the other.
   */
  recurrenceId?: string | null;
};

export type IcsCalendarOptions = {
  name: string;
  description?: string;
  timezone?: string;
  /** Stamp used for DTSTAMP / PRODID generation time. Passed in for determinism. */
  dtstamp: string;
  /** Minutes between refreshes that subscribers should honor. Default 60. */
  refreshIntervalMins?: number;
};

const PRODID = '-//bubaly.com//Sync Platform//EN';

/** Escape per RFC 5545 §3.3.11 (TEXT): backslash, comma, semicolon, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Fold a content line to <=75 octets per RFC 5545 §3.1, continuation = CRLF + space. */
export function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let idx = 0;
  // First line: 75 chars. Continuations: leading space + 74 chars.
  out.push(line.slice(0, 75));
  idx = 75;
  while (idx < line.length) {
    out.push(' ' + line.slice(idx, idx + 74));
    idx += 74;
  }
  return out.join('\r\n');
}

/** ISO -> UTC iCalendar form "YYYYMMDDTHHMMSSZ". */
export function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** ISO -> all-day DATE form "YYYYMMDD" (UTC date component). */
export function toIcsDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function emit(lines: string[], name: string, value: string): void {
  lines.push(foldLine(`${name}:${value}`));
}

export function buildVevent(ev: IcsEvent, dtstamp: string): string[] {
  const lines: string[] = ['BEGIN:VEVENT'];
  emit(lines, 'UID', ev.uid);
  emit(lines, 'DTSTAMP', toIcsUtc(ev.updatedAt ?? dtstamp));
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(ev.startsAt)}`);
    if (ev.endsAt) lines.push(`DTEND;VALUE=DATE:${toIcsDate(ev.endsAt)}`);
  } else {
    emit(lines, 'DTSTART', toIcsUtc(ev.startsAt));
    if (ev.endsAt) emit(lines, 'DTEND', toIcsUtc(ev.endsAt));
  }
  emit(lines, 'SUMMARY', escapeIcsText(ev.title));
  if (ev.description) emit(lines, 'DESCRIPTION', escapeIcsText(ev.description));
  if (ev.location) emit(lines, 'LOCATION', escapeIcsText(ev.location));
  if (ev.recurrenceRule) emit(lines, 'RRULE', ev.recurrenceRule);
  emit(lines, 'STATUS', (ev.status ?? 'confirmed').toUpperCase());
  lines.push('END:VEVENT');
  return lines;
}

/** Build a complete VCALENDAR document (CRLF-terminated) ready to serve. */
export function generateICS(events: IcsEvent[], opts: IcsCalendarOptions): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  emit(lines, 'X-WR-CALNAME', escapeIcsText(opts.name));
  if (opts.description) emit(lines, 'X-WR-CALDESC', escapeIcsText(opts.description));
  if (opts.timezone) emit(lines, 'X-WR-TIMEZONE', opts.timezone);
  const refresh = opts.refreshIntervalMins ?? 60;
  emit(lines, 'X-PUBLISHED-TTL', `PT${refresh}M`);
  emit(lines, 'REFRESH-INTERVAL;VALUE=DURATION', `PT${refresh}M`);
  for (const ev of events) lines.push(...buildVevent(ev, opts.dtstamp));
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ----------------------------------------------------------------------------
// Minimal parser — enough to IMPORT a subscribed/exported ICS into bubaly.
// Handles line unfolding, escaped TEXT, DATE vs UTC DATETIME, RRULE.
// ----------------------------------------------------------------------------
export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Parse an iCalendar DATE / DATE-TIME value into an ISO instant.
 *
 *   DATE            20260620                 → all-day, midnight UTC of that date
 *   UTC DATE-TIME   20260620T143000Z         → that instant
 *   zoned DATE-TIME 20260620T143000 + TZID   → the instant at which the clock in
 *                                              that zone reads 14:30 (DTSTART;TZID=
 *                                              America/New_York:…), so a school
 *                                              calendar published in local time
 *                                              lands at the right hour. A reading
 *                                              the zone skips at spring-forward
 *                                              resolves to the first minute that
 *                                              exists, as the rest of the app does.
 *   floating        20260620T143000, no TZID → read as UTC, as before. There is no
 *                                              observer to be local to here.
 *
 * A TZID this runtime does not know (Windows names such as "Eastern Standard
 * Time") falls back to the floating rule rather than failing the event: a
 * calendar that imports at the wrong hour is recoverable, one that does not
 * import is not. The limit is stated rather than hidden.
 */
export function parseIcsDate(value: string, tzid?: string | null): { iso: string; allDay: boolean } {
  if (/^\d{8}$/.test(value)) {
    return { iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) throw new Error(`Unparseable ICS date: ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  if (!z && tzid && isValidTimezone(tzid)) {
    const at = instantForLocalTime(Number(y), Number(mo), Number(d), Number(h) * 60 + Number(mi), tzid);
    if (at) return { iso: new Date(at.getTime() + Number(s) * 1000).toISOString(), allDay: false };
  }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`, allDay: false };
}

/**
 * Split a content line into name, parameters and value. The value starts at
 * the first `:` outside double quotes: a parameter value may carry a colon
 * when quoted (`TZID="(UTC-05:00) Eastern Time (US & Canada)"`), and taking the
 * first colon blindly made the parameter the value.
 */
function splitContentLine(line: string): { name: string; tzid: string | null; value: string } | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon === -1) return null;
  const [rawName, ...params] = line.slice(0, colon).split(';');
  let tzid: string | null = null;
  for (const param of params) {
    const m = param.match(/^TZID=(.+)$/i);
    if (m) tzid = m[1].replace(/^"(.*)"$/, '$1');
  }
  return { name: rawName.toUpperCase(), tzid, value: line.slice(colon + 1) };
}

export type ParseIcsOptions = {
  /**
   * Keep a STATUS:CANCELLED component that carries only its identity: a UID,
   * and a RECURRENCE-ID when it cancels one occurrence. RFC 5546 §3.2.5 lets a
   * CANCEL omit DTSTART and SUMMARY, and a feed sync needs exactly that identity
   * to remove what an earlier sync imported. Off by default: every other reader
   * wants events it can place, and a cancellation it cannot place is nothing to
   * it. Such an event's `startsAt` is its RECURRENCE-ID when it has one, else ''.
   */
  bareCancellations?: boolean;
};

export function parseICS(text: string, opts: ParseIcsOptions = {}): IcsEvent[] {
  // Unfold: a CRLF (or LF) followed by space/tab continues the previous line.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const events: IcsEvent[] = [];
  let cur: Partial<IcsEvent> & { _start?: string } | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      const placeable = !!(cur && cur.uid && cur.startsAt && cur.title);
      const bareCancellation = !!(cur && cur.uid && cur.status === 'cancelled' && opts.bareCancellations);
      if (cur && (placeable || bareCancellation)) {
        events.push({
          uid: cur.uid as string,
          title: cur.title ?? '',
          description: cur.description ?? null,
          location: cur.location ?? null,
          startsAt: cur.startsAt ?? cur.recurrenceId ?? '',
          endsAt: cur.endsAt ?? null,
          allDay: cur.allDay ?? false,
          recurrenceRule: cur.recurrenceRule ?? null,
          status: cur.status,
          recurrenceId: cur.recurrenceId ?? null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const parsed = splitContentLine(line);
    if (!parsed) continue;
    const { name, tzid, value } = parsed;

    switch (name) {
      case 'UID':
        cur.uid = value;
        break;
      case 'SUMMARY':
        cur.title = unescapeIcsText(value);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeIcsText(value);
        break;
      case 'LOCATION':
        cur.location = unescapeIcsText(value);
        break;
      case 'DTSTART': {
        const { iso, allDay } = parseIcsDate(value, tzid);
        cur.startsAt = iso;
        cur.allDay = allDay;
        break;
      }
      case 'DTEND':
        cur.endsAt = parseIcsDate(value, tzid).iso;
        break;
      case 'RECURRENCE-ID':
        cur.recurrenceId = parseIcsDate(value, tzid).iso;
        break;
      case 'RRULE':
        cur.recurrenceRule = value;
        break;
      case 'STATUS':
        cur.status = value.toLowerCase() as IcsEvent['status'];
        break;
    }
  }
  return events;
}
