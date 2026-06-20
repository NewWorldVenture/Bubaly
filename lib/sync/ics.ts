// lib/sync/ics.ts
//
// RFC 5545 (iCalendar) generation + a pragmatic parser. This is the one piece of
// cross-provider sync that works with NO OAuth and no provider cooperation: any
// calendar app (Apple Calendar, Outlook, Google "from URL", Alexa) can subscribe
// to a generated ICS feed URL and receive theagoras events. Generation is pure
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

const PRODID = '-//theagoras.com//Sync Platform//EN';

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
// Minimal parser — enough to IMPORT a subscribed/exported ICS into theagoras.
// Handles line unfolding, escaped TEXT, DATE vs UTC DATETIME, RRULE.
// ----------------------------------------------------------------------------
export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Parse an iCalendar UTC/DATE value into an ISO string. */
export function parseIcsDate(value: string): { iso: string; allDay: boolean } {
  // DATE: 20260620 ; UTC DATETIME: 20260620T143000Z ; local DATETIME: 20260620T143000
  if (/^\d{8}$/.test(value)) {
    return { iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) throw new Error(`Unparseable ICS date: ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  const suffix = z === 'Z' ? 'Z' : 'Z'; // we normalize naive local times to UTC
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}.000${suffix}`, allDay: false };
}

export function parseICS(text: string): IcsEvent[] {
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
      if (cur && cur.uid && cur.startsAt && cur.title) {
        events.push({
          uid: cur.uid,
          title: cur.title,
          description: cur.description ?? null,
          location: cur.location ?? null,
          startsAt: cur.startsAt,
          endsAt: cur.endsAt ?? null,
          allDay: cur.allDay ?? false,
          recurrenceRule: cur.recurrenceRule ?? null,
          status: cur.status,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = left.split(';')[0].toUpperCase();

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
        const { iso, allDay } = parseIcsDate(value);
        cur.startsAt = iso;
        cur.allDay = allDay;
        break;
      }
      case 'DTEND':
        cur.endsAt = parseIcsDate(value).iso;
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
