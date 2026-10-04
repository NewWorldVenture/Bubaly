// lib/sync/ics.ts
//
// RFC 5545 (iCalendar) generation + a pragmatic parser. This is the one piece of
// cross-provider sync that works with NO OAuth and no provider cooperation: any
// calendar app (Apple Calendar, Outlook, Google "from URL", Alexa) can subscribe
// to a generated ICS feed URL and receive bubaly events. Generation is pure
// and deterministic (timestamps are passed in), so it is fully unit-testable.

import { canonicalZone, IcsClock, iso, readDate, readWall } from '@/lib/onboarding/ics-time';

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
// Handles line unfolding, escaped TEXT, DATE, UTC and explicit IANA DATE-TIME,
// and raw RRULE. Supplied VTIMEZONE definitions and recurrence exceptions are
// not interpreted here. Floating values retain the legacy UTC assumption.
// ----------------------------------------------------------------------------
export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseDateProperty(value: string, params: Record<string, string>, clock: IcsClock,
  declaredZones: ReadonlySet<string>,
): { iso: string; allDay: boolean } {
  const type = params.VALUE?.toUpperCase();
  const zone = params.TZID;
  if (type && type !== 'DATE' && type !== 'DATE-TIME') throw new Error('Unsupported ICS date value type');
  if (type === 'DATE' || (!type && /^\d{8}$/.test(value))) {
    if (zone) throw new Error('ICS DATE cannot carry TZID');
    return { iso: readDate(value) + 'T00:00:00.000Z', allDay: true };
  }
  const utc = value.endsWith('Z');
  if (utc && zone) throw new Error('ICS UTC DATE-TIME cannot carry TZID');
  const wall = readWall(utc ? value.slice(0, -1) : value);
  if (zone) {
    // An explicit declaration can override even a familiar IANA name. This
    // path does not validate those definitions; never disregard one silently.
    if (declaredZones.has(zone)) throw new Error('Unsupported ICS VTIMEZONE declaration');
    return { iso: iso(clock.resolve(wall, canonicalZone(zone))), allDay: false };
  }
  // Compatibility only: without a source zone/observer we still encode floating
  // wall fields as UTC. This is not RFC floating-time fidelity.
  return { iso: iso(wall.ms), allDay: false };
}

/** Parse a UTC/DATE token; legacy floating values keep their UTC assumption. */
export function parseIcsDate(value: string): { iso: string; allDay: boolean } {
  return parseDateProperty(value, {}, new IcsClock(), new Set());
}

function contentLine(line: string): { name: string; value: string; params: Record<string, string> } | null {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) { colon = i; break; }
  }
  if (colon === -1) {
    if (/^(DTSTART|DTEND)(?:;|:|$)/i.test(line)) throw new Error('Invalid ICS date property');
    return null;
  }
  const left = line.slice(0, colon);
  const name = left.split(';')[0].toUpperCase();
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  if (name === 'DTSTART' || name === 'DTEND') {
    // A quoted parameter may contain semicolons or colons. Do not truncate it
    // into a different zone, and reject duplicate/empty temporal parameters.
    const parts: string[] = [];
    let start = left.indexOf(';') + 1;
    quoted = false;
    for (let i = start; start > 0 && i <= left.length; i++) {
      if (left[i] === '"') quoted = !quoted;
      else if (!quoted && (left[i] === ';' || i === left.length)) { parts.push(left.slice(start, i)); start = i + 1; }
    }
    if (quoted) throw new Error('Invalid ICS date parameters');
    for (const part of parts) {
      const equal = part.indexOf('=');
      if (equal < 1) throw new Error('Invalid ICS date parameters');
      const key = part.slice(0, equal).toUpperCase();
      let value = part.slice(equal + 1);
      if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key) || !value) throw new Error('Invalid ICS date parameters');
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      else if (value.includes('"')) throw new Error('Invalid ICS date parameters');
      if (!value) throw new Error('Invalid ICS date parameters');
      params[key] = value;
    }
  }
  return { name, params, value: line.slice(colon + 1) };
}

function timezoneDeclarations(lines: readonly string[]): Set<string> {
  const declarations = new Set<string>();
  let inTimezone = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^BEGIN:VTIMEZONE$/i.test(line)) inTimezone = true;
    else if (/^END:VTIMEZONE$/i.test(line)) inTimezone = false;
    else if (inTimezone && /^TZID(?:;|:)/i.test(line)) {
      const property = contentLine(line);
      if (!property) throw new Error('Unsupported ICS VTIMEZONE declaration');
      declarations.add(property.value);
    }
  }
  return declarations;
}

export function parseICS(text: string): IcsEvent[] {
  // Unfold: a CRLF (or LF) followed by space/tab continues the previous line.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const clock = new IcsClock();
  const declaredZones = timezoneDeclarations(lines);
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

    const property = contentLine(line);
    if (!property) continue;
    const { name, value, params } = property;

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
        const { iso, allDay } = parseDateProperty(value, params, clock, declaredZones);
        cur.startsAt = iso;
        cur.allDay = allDay;
        break;
      }
      case 'DTEND':
        cur.endsAt = parseDateProperty(value, params, clock, declaredZones).iso;
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
