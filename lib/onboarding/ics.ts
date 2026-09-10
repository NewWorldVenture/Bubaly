// lib/onboarding/ics.ts — pure, dependency-free ICS (RFC 5545) parsing for the
// value-first onboarding step (T1). The user pastes their calendar export (or
// tries a generated sample week); we parse it here — no network, no DB — and hand
// the events to buildFirstBrief() for the instant payoff. DOM-free + deterministic
// so it's fully unit-tested. (The authed /api/calendar/sync route has its own
// copy for URL fetches; this one is the onboarding-safe, browser-parseable path.)

import type { BriefEvent } from './first-brief';
import { zonedTimeMs } from '../schedule/zoned';
import { canonicalZone, IcsImportError, invalid, iso, readDate, readDuration, readWall, shiftedDay, type IcsErrorCode, type WallTime } from './ics-time';
import { IcsZones, property, type IcsComponent, type IcsProperty } from './ics-timezone';

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

/** Presentation facts only: excluded from saved drafts and finalization payloads. */
export interface IcsImportDisclosure { floatingTimezone?: string; recurring: boolean }
export type IcsParseResult = { ok: true; events: ParsedIcsEvent[]; disclosure: IcsImportDisclosure }
  | { ok: false; code: IcsErrorCode };

function splitOutsideQuotes(value: string, separator: string): string[] {
  let quoted = false, start = 0;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') quoted = !quoted;
    else if (!quoted && value[i] === separator) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted) return invalid('invalidCalendar');
  parts.push(value.slice(start));
  return parts;
}

function contentLine(line: string): IcsProperty {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === ':') { colon = i; break; }
  }
  if (colon < 0) return invalid('invalidCalendar');
  const header = splitOutsideQuotes(line.slice(0, colon), ';');
  const name = header.shift()!.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return invalid('invalidCalendar');
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const item of header) {
    const at = item.indexOf('=');
    if (at < 1) return invalid('invalidCalendar');
    const key = item.slice(0, at).toUpperCase();
    let value = item.slice(at + 1);
    if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(params, key) || !value) return invalid('invalidCalendar');
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.includes('"')) return invalid('invalidCalendar');
    if (!value) return invalid('invalidCalendar');
    params[key] = key === 'VALUE' ? value.toUpperCase() : value;
  }
  return { name, params, value: line.slice(colon + 1) };
}

function calendarTree(text: string): IcsComponent {
  const root: IcsComponent = { name: 'ROOT', properties: [], children: [] };
  const stack = [root];
  for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    if (!line.trim()) continue;
    const item = contentLine(line);
    const parent = stack.at(-1)!;
    if (item.name === 'BEGIN') {
      const name = item.value.toUpperCase();
      if (Object.keys(item.params).length || !/^[A-Z0-9-]+$/.test(name) || stack.length > 8) return invalid('invalidCalendar');
      if ((name === 'VCALENDAR' && parent !== root) || (name === 'VEVENT' && parent.name !== 'VCALENDAR')) return invalid('invalidCalendar');
      const child: IcsComponent = { name, properties: [], children: [] };
      parent.children.push(child); stack.push(child);
    } else if (item.name === 'END') {
      if (stack.length === 1 || Object.keys(item.params).length || parent.name !== item.value.toUpperCase()) return invalid('invalidCalendar');
      stack.pop();
    } else parent.properties.push(item);
  }
  if (stack.length !== 1 || root.properties.length || root.children.length !== 1 || root.children[0].name !== 'VCALENDAR') return invalid('invalidCalendar');
  return root.children[0];
}

interface EventTime { at: number; allDay: boolean; day: string; wall?: WallTime; zone?: string; floating: boolean; utc: boolean }
function eventTime(item: IcsProperty, zones: IcsZones, floatingTimezone?: string): EventTime {
  const { VALUE: type, TZID: zone } = item.params;
  if (type && type !== 'DATE' && type !== 'DATE-TIME') return invalid('invalidDate');
  const allDay = type === 'DATE' || (!type && /^[0-9]{8}$/.test(item.value));
  if (allDay) {
    if (zone) return invalid('invalidDate');
    const day = readDate(item.value);
    return { at: Date.parse(day + 'T00:00:00Z'), allDay: true, day, floating: false, utc: false };
  }
  const utc = item.value.endsWith('Z');
  if (zone && utc) return invalid('invalidDate');
  const wall = readWall(utc ? item.value.slice(0, -1) : item.value);
  if (utc) return { at: wall.ms, allDay: false, day: wall.day, wall, floating: false, utc: true };
  if (!zone && !floatingTimezone) return invalid('floatingTimezoneRequired');
  const selectedZone = zone ?? floatingTimezone!;
  canonicalZone(selectedZone);
  return { at: zones.resolve(wall, selectedZone), allDay: false, day: wall.day, wall, zone: selectedZone, floating: !zone, utc: false };
}

function parseEvent(component: IcsComponent, index: number, zones: IcsZones, floatingTimezone?: string): { event: ParsedIcsEvent; floating: boolean } {
  if (component.properties.some(item => ['RDATE', 'EXDATE', 'RECURRENCE-ID', 'EXRULE'].includes(item.name))) return invalid('unsupportedRecurrence');
  const start = eventTime(property(component, 'DTSTART', true)!, zones, floatingTimezone);
  const endProperty = property(component, 'DTEND');
  const durationProperty = property(component, 'DURATION');
  if (endProperty && durationProperty) return invalid('invalidDuration');
  let end: number | null = start.allDay ? null : start.at;
  let endUtc = start.utc;
  let floating = start.floating;
  if (endProperty) {
    const parsedEnd = eventTime(endProperty, zones, floatingTimezone);
    if (parsedEnd.allDay !== start.allDay || parsedEnd.floating !== start.floating || parsedEnd.at <= start.at) return invalid('invalidRange');
    end = parsedEnd.at; endUtc = parsedEnd.utc; floating ||= parsedEnd.floating;
  } else if (durationProperty) {
    const duration = readDuration(durationProperty.value);
    if (start.allDay && !/^\+?P[0-9]+[DW]$/.test(durationProperty.value)) return invalid('invalidDuration');
    if (start.allDay) end = Date.parse(shiftedDay(start.day, duration.days) + 'T00:00:00Z');
    else {
      // A gap may have advanced the effective start (even across a skipped date).
      const effective = start.zone ? zones.clock.wallAt(start.at, start.zone) : start.wall!;
      const day = shiftedDay(effective.day, duration.days);
      const wall = { ...effective, day, ms: Date.parse(day + 'T00:00:00Z') + effective.hour * 3_600_000 + effective.minute * 60_000 + effective.second * 1000 };
      end = (duration.days ? (start.zone ? zones.resolve(wall, start.zone) : wall.ms) : start.at) + duration.seconds * 1000;
      if (start.zone) zones.note(start.zone, end);
    }
    if (end <= start.at) return invalid('invalidDuration');
  }
  const title = property(component, 'SUMMARY')?.value.trim() ?? 'Untitled';
  if (title.length > 200 || (property(component, 'LOCATION')?.value.length ?? 0) > 200) return invalid('invalidCalendar');
  return { floating, event: {
    uid: property(component, 'UID')?.value.trim() ?? 'ics-' + index,
    title: unescapeIcs(title),
    start: start.utc ? iso(start.at).replace('.000Z', 'Z') : iso(start.at),
    end: end === null ? null : endUtc ? iso(end).replace('.000Z', 'Z') : iso(end),
    allDay: start.allDay,
    location: property(component, 'LOCATION') ? unescapeIcs(property(component, 'LOCATION')!.value.trim()) : null,
    notes: property(component, 'DESCRIPTION') ? unescapeIcs(property(component, 'DESCRIPTION')!.value.trim()) : null,
    rrule: property(component, 'RRULE')?.value.trim() ?? null,
  } };
}

/** Whole-paste parsing: unsupported temporal data never produces a partial successful import. */
export function parseIcsResult(text: string, options: { floatingTimezone?: string } = {}): IcsParseResult {
  try {
    if (typeof text !== 'string' || !text.trim()) return invalid('invalidCalendar');
    if (text.length > 200_000) return invalid('tooManyEvents');
    const calendar = calendarTree(text);
    const components = calendar.children.filter(component => component.name === 'VEVENT');
    if (components.length > 1000) return invalid('tooManyEvents');
    const zones = new IcsZones(calendar.children.filter(component => component.name === 'VTIMEZONE'));
    const events: ParsedIcsEvent[] = [];
    let floating = false;
    for (const component of components) {
      const parsed = parseEvent(component, events.length, zones, options.floatingTimezone);
      events.push(parsed.event); floating ||= parsed.floating;
    }
    zones.verify();
    return { ok: true, events, disclosure: { ...(floating ? { floatingTimezone: options.floatingTimezone } : {}), recurring: events.some(event => !!event.rrule) } };
  } catch (error) {
    return { ok: false, code: error instanceof IcsImportError ? error.code : 'invalidCalendar' };
  }
}

/** Compatibility for pure callers: invalid input is empty, never partially parsed. */
export function parseIcs(text: string, options: { floatingTimezone?: string } = {}): ParsedIcsEvent[] {
  const parsed = parseIcsResult(text, options);
  return parsed.ok ? parsed.events : [];
}

/** Strict single-token compatibility helper; local values require an explicit zone. */
export function parseIcsDate(key: string, value: string, floatingTimezone?: string): string {
  try {
    const parsed = eventTime(contentLine(key + ':' + value), new IcsZones([]), floatingTimezone);
    return parsed.utc ? iso(parsed.at).replace('.000Z', 'Z') : iso(parsed.at);
  } catch { return ''; }
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
 * feel the payoff. Anchored to the family's local day so today has events — including one
 * deliberate clash (soccer vs. dentist) and a couple of location-less events so
 * the brief surfaces real conflicts + actions. Pure + deterministic.
 */
export function demoBriefEvents(now: Date, timezone = 'UTC'): BriefEvent[] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const localDay = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  const anchor = Date.parse(`${localDay}T12:00:00Z`);
  const day = (offset: number, h: number, m = 0): string => {
    // Advance calendar dates, then resolve each day's clock with its own DST offset.
    const date = new Date(anchor + offset * 86_400_000).toISOString().slice(0, 10);
    return new Date(zonedTimeMs(date, h, m, timezone)).toISOString();
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
