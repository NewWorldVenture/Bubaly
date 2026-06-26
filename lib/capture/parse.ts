// lib/capture/parse.ts — lightweight natural-language date/time parsing for
// Quick Capture events. Pure + deterministic (inject `now`), no external deps,
// so "Dentist at 3pm tomorrow" lands on the calendar at the right time instead
// of "now" — and the recognized phrase is stripped from the event title.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export type ParsedEvent = {
  /** The input with the recognized date/time phrase removed (falls back to the raw input). */
  title: string;
  /** Resolved start. When nothing is recognized this is `now`. */
  startsAt: Date;
  /** True when a day was given but no clock time (renders as an all-day event). */
  allDay: boolean;
  /** Whether any date/time phrase was actually recognized. */
  matched: boolean;
};

/** Parse a clock time: "3pm", "at 3:30 pm", "15:30", "noon", "midnight". */
function parseTime(input: string): { minutes: number; match: string } | null {
  const noon = input.match(/\b(at\s+)?noon\b/i);
  if (noon) return { minutes: 12 * 60, match: noon[0] };
  const midnight = input.match(/\b(at\s+)?midnight\b/i);
  if (midnight) return { minutes: 0, match: midnight[0] };

  // 12-hour: 3pm, 3:30pm, at 3 pm, 11.45am
  const twelve = input.match(/\b(at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?\b/i);
  if (twelve) {
    let h = parseInt(twelve[2], 10);
    const m = twelve[3] ? parseInt(twelve[3], 10) : 0;
    const pm = twelve[4].toLowerCase() === 'p';
    if (h < 1 || h > 12 || m > 59) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
    return { minutes: h * 60 + m, match: twelve[0] };
  }

  // 24-hour: 15:30, at 09:00 (require a colon so we don't grab bare counts)
  const twentyFour = input.match(/\b(at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFour) {
    const h = parseInt(twentyFour[2], 10);
    const m = parseInt(twentyFour[3], 10);
    return { minutes: h * 60 + m, match: twentyFour[0] };
  }
  return null;
}

/** Parse a day reference: today/tonight/tomorrow, weekday names, "in N days/weeks". */
function parseDay(input: string, now: Date): { date: Date; match: string; eveningHint: boolean } | null {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (/\btoday\b/i.test(input)) return { date: base, match: input.match(/\btoday\b/i)![0], eveningHint: false };
  if (/\btonight\b/i.test(input)) return { date: base, match: input.match(/\btonight\b/i)![0], eveningHint: true };
  if (/\b(tomorrow|tmrw|tmr)\b/i.test(input)) {
    const d = new Date(base); d.setDate(d.getDate() + 1);
    return { date: d, match: input.match(/\b(tomorrow|tmrw|tmr)\b/i)![0], eveningHint: false };
  }

  const inN = input.match(/\bin\s+(\d{1,3})\s+(day|days|week|weeks)\b/i);
  if (inN) {
    const n = parseInt(inN[1], 10);
    const d = new Date(base);
    d.setDate(d.getDate() + (/week/i.test(inN[2]) ? n * 7 : n));
    return { date: d, match: inN[0], eveningHint: false };
  }

  // "next monday" / "this friday" / bare "tuesday" → the coming occurrence.
  const wd = input.match(/\b(this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wd) {
    const isNext = /next/i.test(wd[1] ?? '');
    const target = WEEKDAYS.indexOf(wd[2].toLowerCase());
    const d = new Date(base);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;           // a bare/“this” weekday that is today → the coming one
    if (isNext) delta += 7;               // “next” pushes a further week out
    d.setDate(d.getDate() + delta);
    return { date: d, match: wd[0].trim(), eveningHint: false };
  }
  return null;
}

/** Remove a matched phrase and tidy dangling connectors / whitespace. */
function stripPhrase(text: string, phrase: string | null): string {
  if (!phrase) return text;
  let out = text.replace(phrase, ' ');
  out = out.replace(/\s+(at|on|by)\s*$/i, ' ');
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

/**
 * Parse a free-text event capture into a title + start time.
 * If nothing is recognized, returns `{ startsAt: now, allDay: false, matched: false }`
 * so callers keep the legacy "starts now" behavior.
 */
export function parseEvent(input: string, now: Date = new Date()): ParsedEvent {
  const raw = input.trim();
  const day = parseDay(raw, now);
  const time = parseTime(raw);

  let title = raw;
  title = stripPhrase(title, day?.match ?? null);
  title = stripPhrase(title, time?.match ?? null);

  // Resolve the start instant.
  let startsAt: Date;
  let allDay: boolean;
  if (time) {
    const d = day ? new Date(day.date) : (() => { const t = new Date(now); t.setHours(0, 0, 0, 0); return t; })();
    d.setMinutes(time.minutes);
    // No explicit day + a time already past today → assume tomorrow.
    if (!day && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    startsAt = d;
    allDay = false;
  } else if (day) {
    const d = new Date(day.date);
    if (day.eveningHint) { d.setHours(19, 0, 0, 0); allDay = false; }
    else { allDay = true; }
    startsAt = d;
  } else {
    startsAt = new Date(now);
    allDay = false;
  }

  return { title: title || raw, startsAt, allDay, matched: Boolean(day || time) };
}

/** Local YYYY-MM-DD (date-only, no timezone shift). */
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type ParsedTask = {
  /** Input with a recognized day (and any trailing time) removed. */
  title: string;
  /** Local YYYY-MM-DD due date, or null when no day reference was found. */
  dueDate: string | null;
};

/**
 * Parse a free-text task into a title + optional due date. Only a *day*
 * reference (today/tomorrow/weekday/in N days) sets a due date — a bare clock
 * time alone does not, since `todo_items.due_date` is date-only. The recognized
 * phrase is stripped from the title.
 */
export function parseDueDate(input: string, now: Date = new Date()): ParsedTask {
  const raw = input.trim();
  const day = parseDay(raw, now);
  if (!day) return { title: raw, dueDate: null };
  const time = parseTime(raw);
  let title = stripPhrase(raw, day.match);
  if (time) title = stripPhrase(title, time.match);
  return { title: title || raw, dueDate: toYMD(day.date) };
}

export type CaptureKind = 'task' | 'note' | 'event' | 'shopping';

/**
 * Best-guess capture type from free text, so the sheet can offer a one-tap
 * switch ("looks like an event"). Priority: explicit shopping verbs →
 * a recognized date/time (event) → other shopping cues → long/labelled note →
 * task (default). Deliberately conservative; the user can always override.
 */
export function suggestKind(input: string, now: Date = new Date()): CaptureKind {
  const t = input.trim().toLowerCase();
  if (!t) return 'task';

  // Strong, unambiguous shopping intent wins even over a trailing day.
  if (/^(buy|purchase)\b/.test(t) || /\b(grocer(y|ies)|shopping list)\b/.test(t)) return 'shopping';

  // A concrete date/time is a strong event signal.
  if (parseEvent(input, now).matched) return 'event';

  // Softer shopping cues (no time present at this point).
  if (/^(pick up|grab|get)\b/.test(t)) return 'shopping';

  // Notes: explicitly labelled or long free-form text.
  if (/^(note|idea)\s*[:\-]/.test(t) || t.length > 80) return 'note';

  return 'task';
}
