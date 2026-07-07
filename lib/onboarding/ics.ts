// lib/onboarding/ics.ts — pure, dependency-free ICS (RFC 5545) parsing for the
// value-first onboarding step (T1). The user pastes their calendar export (or
// tries a generated sample week); we parse it here — no network, no DB — and hand
// the events to buildFirstBrief() for the instant payoff. DOM-free + deterministic
// so it's fully unit-tested. (The authed /api/calendar/sync route has its own
// copy for URL fetches; this one is the onboarding-safe, browser-parseable path.)

import type { BriefEvent } from './first-brief';

export interface ParsedIcsEvent {
  uid: string;
  title: string;
  start: string;            // ISO 8601
  end: string | null;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  rrule: string | null;
}

function unescapeIcs(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** Parse an ICS date/datetime token into an ISO string. Falls back to '' on junk. */
export function parseIcsDate(key: string, val: string): string {
  const raw = (val ?? '').trim();
  const isDate = key.toUpperCase().includes('VALUE=DATE') || (raw.length === 8 && !raw.includes('T'));
  if (isDate) {
    if (raw.length < 8) return '';
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`;
  }
  const clean = raw.replace('Z', '');
  if (clean.length < 15) return '';
  const y = clean.slice(0, 4), mo = clean.slice(4, 6), d = clean.slice(6, 8);
  const h = clean.slice(9, 11), mi = clean.slice(11, 13), s = clean.slice(13, 15);
  const z = raw.endsWith('Z') ? 'Z' : '.000Z';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${z}`;
}

/**
 * Hand-rolled RFC 5545 VEVENT parser. Unfolds continuation lines, reads the
 * fields we care about, and drops anything without a usable start. Never throws —
 * a malformed paste yields an empty array, not an error.
 */
export function parseIcs(text: string): ParsedIcsEvent[] {
  if (!text || typeof text !== 'string') return [];
  const events: ParsedIcsEvent[] = [];
  // Unfold folded lines (a leading space/tab continues the previous line).
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '').split('\n');

  let cur: Partial<ParsedIcsEvent> | null = null;
  for (const raw of lines) {
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).toUpperCase();
    const val = raw.slice(colon + 1);

    if (key === 'BEGIN' && val.trim() === 'VEVENT') { cur = {}; continue; }
    if (key === 'END' && val.trim() === 'VEVENT') {
      if (cur && cur.start) {
        events.push({
          uid: cur.uid ?? `ics-${events.length}`,
          title: cur.title ?? 'Untitled',
          start: cur.start,
          end: cur.end ?? null,
          allDay: cur.allDay ?? false,
          location: cur.location ?? null,
          notes: cur.notes ?? null,
          rrule: cur.rrule ?? null,
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;

    const base = key.split(';')[0];
    switch (base) {
      case 'UID': cur.uid = val.trim(); break;
      case 'SUMMARY': cur.title = unescapeIcs(val.trim()); break;
      case 'DESCRIPTION': cur.notes = unescapeIcs(val.trim()); break;
      case 'LOCATION': cur.location = unescapeIcs(val.trim()); break;
      case 'RRULE': cur.rrule = val.trim(); break;
      case 'DTSTART': cur.start = parseIcsDate(key, val); cur.allDay = key.toUpperCase().includes('VALUE=DATE') || val.trim().length === 8; break;
      case 'DTEND': cur.end = parseIcsDate(key, val); break;
      default: break;
    }
  }
  return events;
}

/** Narrow parsed events to the minimal shape the brief engine consumes. */
export function toBriefEvents(parsed: ParsedIcsEvent[]): BriefEvent[] {
  return parsed
    .filter((e) => !!e.start)
    .map((e) => ({
      title: e.title || 'Untitled',
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      location: e.location,
      recurring: !!e.rrule,
    }));
}

/**
 * A realistic, generated "sample week" so a user with nothing to paste can still
 * feel the payoff. Anchored to `now` so today always has events — including one
 * deliberate clash (soccer vs. dentist) and a couple of location-less events so
 * the brief surfaces real conflicts + actions. Pure + deterministic.
 */
export function demoBriefEvents(now: Date): BriefEvent[] {
  const day = (offset: number, h: number, m = 0): string => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, h, m, 0));
    return d.toISOString();
  };
  return [
    // Today — includes a clash (16:00 overlap) and a location-less event.
    { title: 'Work standup', start: day(0, 9), end: day(0, 9, 30), location: 'Home office', recurring: true },
    { title: 'Soccer practice', start: day(0, 16), end: day(0, 17, 30), location: 'Field 3', recurring: true },
    { title: 'Dentist — Mia', start: day(0, 16, 30), end: day(0, 17, 15), location: null, recurring: false },
    { title: 'Family dinner', start: day(0, 18, 30), end: day(0, 19, 30), location: 'Home', recurring: true },
    // Tomorrow
    { title: 'Piano lesson', start: day(1, 15, 30), end: day(1, 16, 30), location: 'Studio', recurring: true },
    { title: 'Parent-teacher night', start: day(1, 18), end: day(1, 19), location: null, recurring: false },
    // Rest of the week
    { title: 'Swim meet', start: day(2, 8), end: day(2, 11), location: 'Aquatic Center', recurring: false },
    { title: 'Grocery run', start: day(2, 17), end: day(2, 18), location: null, recurring: true },
    { title: 'Book club', start: day(3, 19), end: day(3, 20, 30), location: "Grandma's", recurring: true },
    { title: 'Robotics club', start: day(4, 15, 30), end: day(4, 17), location: 'School', recurring: true },
    { title: 'Movie night', start: day(5, 19), end: day(5, 21), location: 'Home', recurring: true },
    { title: 'Farmers market', start: day(6, 9), end: day(6, 10, 30), location: 'Downtown', recurring: true },
  ];
}
