// Strict temporal primitives for pasted calendars. No provider, clock or database access.
export type IcsErrorCode = 'invalidCalendar' | 'invalidDate' | 'invalidRange' | 'invalidDuration'
  | 'unsupportedTimezone' | 'floatingTimezoneRequired' | 'unsupportedRecurrence' | 'tooManyEvents';

export class IcsImportError extends Error {
  constructor(readonly code: IcsErrorCode) { super(code); }
}
export function invalid(code: IcsErrorCode): never { throw new IcsImportError(code); }
export const DAY_MS = 86_400_000;

export interface WallTime {
  day: string;
  hour: number;
  minute: number;
  second: number;
  ms: number; // The wall fields encoded as UTC, not their resolved instant.
}

export function validDay(day: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) || day.startsWith('0000')) return false;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function readDate(value: string): string {
  if (!/^[0-9]{8}$/.test(value)) return invalid('invalidDate');
  const day = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6);
  if (!validDay(day)) return invalid('invalidDate');
  return day;
}

export function readWall(value: string): WallTime {
  const match = /^([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})$/.exec(value);
  if (!match) return invalid('invalidDate');
  const day = readDate(match[1]);
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4]);
  // Leap-second imports are explicitly unsupported; never roll invalid fields forward.
  if (hour > 23 || minute > 59 || second > 59) return invalid('invalidDate');
  return { day, hour, minute, second, ms: Date.parse(day + 'T' + match[2] + ':' + match[3] + ':' + match[4] + 'Z') };
}

export function iso(ms: number): string {
  if (!Number.isFinite(ms)) return invalid('invalidDate');
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return invalid('invalidDate');
  return date.toISOString();
}

export function shiftedDay(day: string, days: number): string {
  return iso(Date.parse(day + 'T12:00:00Z') + days * DAY_MS).slice(0, 10);
}

// Bare names explicitly published by IANA tzdb backward/etcetera (2026c).
// Intl additionally accepts ambiguous ICU abbreviations (e.g. CST/PST), which
// are not IANA identifiers and must not silently select a geographic region.
const IANA_BARE_NAMES = new Set([
  'CET', 'CST6CDT', 'Cuba', 'EET', 'EST', 'EST5EDT', 'Egypt', 'Eire',
  'GB', 'GB-Eire', 'GMT', 'GMT+0', 'GMT-0', 'GMT0', 'Greenwich', 'HST',
  'Hongkong', 'Iceland', 'Iran', 'Israel', 'Jamaica', 'Japan', 'Kwajalein',
  'Libya', 'MET', 'MST', 'MST7MDT', 'NZ', 'NZ-CHAT', 'Navajo', 'PRC',
  'PST8PDT', 'Poland', 'Portugal', 'ROC', 'ROK', 'Singapore', 'Turkey',
  'UCT', 'UTC', 'Universal', 'W-SU', 'WET', 'Zulu',
]);

export function canonicalZone(zone: string): string {
  if (typeof zone !== 'string' || !zone || zone.length > 100 || zone.trim() !== zone
    || zone.startsWith('/') || !/^[A-Za-z0-9_+\-/]+$/.test(zone)
    || (!zone.includes('/') && !IANA_BARE_NAMES.has(zone))) return invalid('unsupportedTimezone');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return invalid('unsupportedTimezone'); }
}

export class IcsClock {
  private formatters = new Map<string, Intl.DateTimeFormat>();
  private formatter(zone: string): Intl.DateTimeFormat {
    let formatter = this.formatters.get(zone);
    if (!formatter) {
      canonicalZone(zone);
      if (this.formatters.size >= 128) return invalid('unsupportedTimezone');
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      this.formatters.set(zone, formatter);
    }
    return formatter;
  }

  wallAt(ms: number, zone: string): WallTime {
    iso(ms);
    const parts = Object.fromEntries(this.formatter(zone).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
    return readWall(parts.year.padStart(4, '0') + parts.month + parts.day + 'T' + parts.hour + parts.minute + parts.second);
  }

  offsetAt(ms: number, zone: string): number {
    const second = Math.floor(ms / 1000) * 1000;
    return this.wallAt(second, zone).ms - second;
  }

  resolve(wall: WallTime, zone: string): number {
    canonicalZone(zone);
    // Candidate offsets on both sides also cover half-hour and date-line changes.
    const offsets = new Set([-2, -1, 0, 1, 2].map(days => this.offsetAt(wall.ms + days * DAY_MS, zone)));
    const candidates = [...offsets].map(offset => ({ instant: wall.ms - offset, offset }));
    const exact = candidates.filter(candidate => this.wallAt(candidate.instant, zone).ms === wall.ms)
      .sort((a, b) => a.instant - b.instant);
    if (exact.length) return exact[0].instant; // RFC 5545: the first occurrence in a fold.
    const gaps = candidates.map(candidate => ({ ...candidate, shift: this.wallAt(candidate.instant, zone).ms - wall.ms }))
      .filter(candidate => candidate.shift > 0
        && candidates.some(other => other.instant < candidate.instant
          && this.wallAt(other.instant, zone).ms < wall.ms
          && this.offsetAt(other.instant, zone) === candidate.offset))
      .sort((a, b) => a.shift - b.shift);
    // In a gap the preceding offset maps the requested fields forward across it.
    if (gaps.length) return gaps[0].instant;
    return invalid('unsupportedTimezone');
  }
}

export interface IcsDuration { days: number; seconds: number }
export function readDuration(value: string): IcsDuration {
  const week = /^\+?P([0-9]+)W$/.exec(value);
  const parts = /^\+?P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/.exec(value);
  if (!week && (!parts || !parts.slice(1).some(Boolean) || value.endsWith('T'))) return invalid('invalidDuration');
  const days = week ? Number(week[1]) * 7 : Number(parts![1] ?? 0);
  const seconds = week ? 0 : Number(parts![2] ?? 0) * 3600 + Number(parts![3] ?? 0) * 60 + Number(parts![4] ?? 0);
  if (!Number.isSafeInteger(days) || !Number.isSafeInteger(seconds) || days > 3_652_058
    || seconds > 315_537_897_599 || days + seconds === 0) return invalid('invalidDuration');
  return { days, seconds };
}

/** Check browser-returned pasted events before any onboarding mutations. */
export function normalizedImportEvents(events: readonly { start: string; end?: string | null; allDay?: boolean }[]): boolean {
  const instant = (value: string): boolean => {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(value)) return false;
    try { return iso(Date.parse(value)).replace('.000Z', 'Z') === value.replace('.000Z', 'Z'); } catch { return false; }
  };
  return events.every(event => {
    if (!instant(event.start)) return false;
    if (event.end != null && (!instant(event.end) || Date.parse(event.end) < Date.parse(event.start))) return false;
    if (event.allDay && (!event.start.endsWith('T00:00:00.000Z')
      || (event.end != null && (!event.end.endsWith('T00:00:00.000Z') || event.end <= event.start)))) return false;
    return true;
  });
}
