// lib/onboarding/first-brief.ts — the instant "here's your day/week" payoff that
// makes the first session unforgettable (T1). Pure + deterministic: given the
// events the user just imported (paste .ics or the sample week) and `now`, it
// computes today's timeline, likely conflicts, a short prioritized action list,
// and the time-saved opportunities — the concrete value shown BEFORE we ask the
// family to configure anything. DOM-free so the whole thing is unit-tested; the
// value step is a thin renderer, and the same brief summary is persisted to
// onboarding_imports at finalize (the seed of the TTFV metric).

import { pickDinnerIdeas, type DinnerIdea } from './dinner-ideas';
import type { FirstBriefDisplay, BriefConflictDisplay, BriefActionDisplay, BriefOpportunityDisplay } from './first-brief-display';

export interface BriefEvent {
  title: string;
  start: string;              // ISO 8601
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  recurring?: boolean;
}

export interface TimelineItem {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  timeLabel: string;          // "9:00 AM" or "All day"
}

export interface BriefConflict {
  aTitle: string;
  bTitle: string;
  dayLabel: string;           // "Today" | "Tomorrow" | "Wed"
  overlapLabel: string;       // "4:30–5:30 PM"
  display?: BriefConflictDisplay;
}

export type ActionKind = 'conflict' | 'prep' | 'location';
export interface BriefAction {
  id: string;
  kind: ActionKind;
  label: string;
  detail: string;
  display?: BriefActionDisplay;
}

export interface BriefOpportunity {
  id: string;
  label: string;
  detail: string;
  minutes: number;            // estimated time saved
  display?: BriefOpportunityDisplay;
}

export interface FirstBrief {
  now: string;
  headline: string;
  todayCount: number;
  weekCount: number;
  timeline: TimelineItem[];
  conflicts: BriefConflict[];
  actions: BriefAction[];
  opportunities: BriefOpportunity[];
  dinnerIdeas: DinnerIdea[];
  timeSavedMinutes: number;
  /** Optional presentation facts; excluded from the durable briefSummary. */
  display?: FirstBriefDisplay;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

function calendarDayAfter(key: string): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Minutes since midnight UTC for an ISO datetime (for same-day ordering/labels). */
function endOf(ev: BriefEvent): number {
  const start = Date.parse(ev.start);
  const end = ev.end ? Date.parse(ev.end) : NaN;
  return Number.isFinite(end) && end > start ? end : start + 60 * 60_000; // default 1h
}

function fmtTime(iso: string, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(iso));
  let h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtRange(startIso: string, endMs: number, formatter: Intl.DateTimeFormat): string {
  const a = fmtTime(startIso, formatter);
  const b = fmtTime(new Date(endMs).toISOString(), formatter);
  return `${a}–${b}`;
}

function dayLabel(k: string, todayKey: string, tomorrow: string): string {
  if (k === todayKey) return 'Today';
  if (k === tomorrow) return 'Tomorrow';
  return WEEKDAYS[new Date(`${k}T12:00:00Z`).getUTCDay()];
}

/**
 * Build the first-run brief. Everything is derived from the imported events + now;
 * an empty import yields a valid, calm brief (no crash, honest "nothing yet").
 * `dinnerCandidates` (the curated meal_ideas catalog) is optional — omit it and
 * the brief simply carries no dinner ideas (keeps the engine pure + DB-free).
 */
export function buildFirstBrief(events: BriefEvent[], now: Date, dinnerCandidates: DinnerIdea[] = [], timezone = 'UTC'): FirstBrief {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  const dayKey = (instant: string | Date) => {
    const parts = dateFormatter.formatToParts(typeof instant === 'string' ? new Date(instant) : instant);
    return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
  };
  // All-day dates are calendar dates, even when transport normalized them to
  // UTC midnight. Timed events are instants and belong to the family's zone.
  const eventDayKey = (event: BriefEvent) => event.allDay ? event.start.slice(0, 10) : dayKey(event.start);
  const valid = (events ?? []).filter((e) => e && typeof e.start === 'string' && Number.isFinite(Date.parse(e.start)));
  const nowMs = now.getTime();
  const weekEndMs = nowMs + 7 * DAY_MS;
  const todayKey = dayKey(now);
  const tomorrowKey = calendarDayAfter(todayKey);

  // Sort by start so timelines and conflict scans are stable.
  const sorted = [...valid].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Today's timeline (all-day first, then chronological).
  const today = sorted.filter((e) => eventDayKey(e) === todayKey);
  const timeline: TimelineItem[] = [
    ...today.filter((e) => e.allDay),
    ...today.filter((e) => !e.allDay),
  ].map((e) => ({
    title: e.title,
    start: e.start,
    end: e.end ?? null,
    allDay: !!e.allDay,
    location: e.location ?? null,
    timeLabel: e.allDay ? 'All day' : fmtTime(e.start, timeFormatter),
  }));

  // Events within the next 7 days (the planning horizon for conflicts/actions).
  const week = sorted.filter((e) => {
    const t = Date.parse(e.start);
    return t >= nowMs - DAY_MS && t <= weekEndMs && !e.allDay;
  });

  // Conflicts: overlapping timed events on the same day.
  const conflicts: BriefConflict[] = [];
  for (let i = 0; i < week.length; i++) {
    for (let j = i + 1; j < week.length; j++) {
      const a = week[i], b = week[j];
      if (eventDayKey(a) !== eventDayKey(b)) continue;
      const aStart = Date.parse(a.start), aEnd = endOf(a);
      const bStart = Date.parse(b.start), bEnd = endOf(b);
      if (aStart < bEnd && bStart < aEnd) {
        conflicts.push({
          aTitle: a.title,
          bTitle: b.title,
          dayLabel: dayLabel(eventDayKey(a), todayKey, tomorrowKey),
          overlapLabel: fmtRange(new Date(Math.max(aStart, bStart)).toISOString(), Math.min(aEnd, bEnd), timeFormatter),
          display: {
            dayKey: eventDayKey(a),
            overlapStart: new Date(Math.max(aStart, bStart)).toISOString(),
            overlapEnd: new Date(Math.min(aEnd, bEnd)).toISOString(),
          },
        });
      }
    }
  }

  // Actions — prioritized: resolve clashes → prep for today/tomorrow → fill gaps.
  const actions: BriefAction[] = [];
  for (const c of conflicts.slice(0, 3)) {
    actions.push({
      id: `conflict:${c.aTitle}:${c.bTitle}`,
      kind: 'conflict',
      label: `Resolve a clash ${c.dayLabel.toLowerCase()}`,
      detail: `${c.aTitle} overlaps ${c.bTitle} (${c.overlapLabel}). Decide who covers what.`,
      display: { kind: 'conflict', conflictIndex: conflicts.indexOf(c) },
    });
  }
  const missingLocation = week.filter((e) => !e.location && (eventDayKey(e) === todayKey || eventDayKey(e) === tomorrowKey));
  for (const e of missingLocation.slice(0, 3)) {
    actions.push({
      id: `location:${e.title}:${e.start}`,
      kind: 'location',
      label: `Add a location`,
      detail: `“${e.title}” ${dayLabel(eventDayKey(e), todayKey, tomorrowKey).toLowerCase()} has no place set.`,
      display: { kind: 'location', title: e.title, dayKey: eventDayKey(e) },
    });
  }
  if (timeline.length > 0 && actions.length < 6) {
    const first = timeline.find((t) => !t.allDay) ?? timeline[0];
    actions.push({
      id: `prep:${first.title}`,
      kind: 'prep',
      label: 'Get ready for today',
      detail: `First up: ${first.title}${first.timeLabel !== 'All day' ? ` at ${first.timeLabel}` : ''}.`,
      display: { kind: 'prep', timelineIndex: timeline.indexOf(first) },
    });
  }

  // Time-saved opportunities.
  const recurringCount = week.filter((e) => e.recurring).length;
  const opportunities: BriefOpportunity[] = [];
  if (recurringCount > 0) {
    opportunities.push({
      id: 'recurring',
      label: `${recurringCount} recurring event${recurringCount === 1 ? '' : 's'} on autopilot`,
      detail: 'Bubaly keeps these on your calendar and reminds you — no re-entering.',
      minutes: recurringCount * 5,
      display: { kind: 'recurring', count: recurringCount },
    });
  }
  if (conflicts.length > 0) {
    opportunities.push({
      id: 'conflicts',
      label: `${conflicts.length} clash${conflicts.length === 1 ? '' : 'es'} caught for you`,
      detail: 'We spotted these before they became a scramble.',
      minutes: conflicts.length * 15,
      display: { kind: 'conflicts', count: conflicts.length },
    });
  }
  if (week.length > 0) {
    opportunities.push({
      id: 'week',
      label: 'Your week, already organized',
      detail: `${week.length} event${week.length === 1 ? '' : 's'} sorted into one shared timeline.`,
      minutes: Math.min(week.length, 40) * 2,
      display: { kind: 'week', count: week.length },
    });
  }
  const top = opportunities.sort((a, b) => b.minutes - a.minutes).slice(0, 3);
  const timeSavedMinutes = top.reduce((s, o) => s + o.minutes, 0);

  // Headline.
  const localCalendarDate = new Date(`${todayKey}T12:00:00Z`);
  const dow = WEEKDAYS_LONG[localCalendarDate.getUTCDay()];
  let headline: string;
  let headlineDisplay: FirstBriefDisplay['headline'];
  if (timeline.length === 0 && week.length === 0) {
    headline = "You're set up — add your first plans and Bubaly takes it from here.";
    headlineDisplay = 'empty';
  } else if (conflicts.length > 0) {
    headline = `Here's your ${dow} — ${timeline.length} event${timeline.length === 1 ? '' : 's'}, ${conflicts.length} clash${conflicts.length === 1 ? '' : 'es'} to resolve.`;
    headlineDisplay = 'conflicts';
  } else {
    headline = `Here's your ${dow} — ${timeline.length} event${timeline.length === 1 ? '' : 's'}, and you're in good shape.`;
    headlineDisplay = 'clear';
  }

  // 3 dinner ideas that fit the day (quick when today is busy, more involved on
  // the weekend). Drawn from the curated catalog passed in by the caller.
  const dinnerIdeas = pickDinnerIdeas(dinnerCandidates, { now: localCalendarDate, busyCount: timeline.length });

  return {
    now: now.toISOString(),
    headline,
    todayCount: timeline.length,
    weekCount: week.length,
    timeline,
    conflicts,
    actions: actions.slice(0, 6),
    opportunities: top,
    dinnerIdeas,
    timeSavedMinutes,
    display: { version: 1, timezone, dayKey: todayKey, headline: headlineDisplay },
  };
}

/** Compact summary persisted to onboarding_imports.brief (JSON, no PII beyond titles). */
export function briefSummary(brief: FirstBrief): Record<string, unknown> {
  return {
    headline: brief.headline,
    todayCount: brief.todayCount,
    weekCount: brief.weekCount,
    conflictCount: brief.conflicts.length,
    actionCount: brief.actions.length,
    dinnerCount: brief.dinnerIdeas.length,
    timeSavedMinutes: brief.timeSavedMinutes,
    opportunities: brief.opportunities.map((o) => ({ label: o.label, minutes: o.minutes })),
  };
}
