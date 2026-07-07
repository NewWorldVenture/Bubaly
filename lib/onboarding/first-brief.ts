// lib/onboarding/first-brief.ts — the instant "here's your day/week" payoff that
// makes the first session unforgettable (T1). Pure + deterministic: given the
// events the user just imported (paste .ics or the sample week) and `now`, it
// computes today's timeline, likely conflicts, a short prioritized action list,
// and the time-saved opportunities — the concrete value shown BEFORE we ask the
// family to configure anything. DOM-free so the whole thing is unit-tested; the
// value step is a thin renderer, and the same brief summary is persisted to
// onboarding_imports at finalize (the seed of the TTFV metric).

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
}

export type ActionKind = 'conflict' | 'prep' | 'location';
export interface BriefAction {
  id: string;
  kind: ActionKind;
  label: string;
  detail: string;
}

export interface BriefOpportunity {
  id: string;
  label: string;
  detail: string;
  minutes: number;            // estimated time saved
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
  timeSavedMinutes: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Minutes since midnight UTC for an ISO datetime (for same-day ordering/labels). */
function endOf(ev: BriefEvent): number {
  const start = Date.parse(ev.start);
  const end = ev.end ? Date.parse(ev.end) : NaN;
  return Number.isFinite(end) && end > start ? end : start + 60 * 60_000; // default 1h
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtRange(startIso: string, endMs: number): string {
  const a = fmtTime(startIso);
  const b = fmtTime(new Date(endMs).toISOString());
  return `${a}–${b}`;
}

function dayLabel(iso: string, now: Date): string {
  const todayKey = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  const k = utcDayKey(iso);
  if (k === todayKey) return 'Today';
  if (k === tomorrow) return 'Tomorrow';
  return WEEKDAYS[new Date(iso).getUTCDay()];
}

/**
 * Build the first-run brief. Everything is derived from the imported events + now;
 * an empty import yields a valid, calm brief (no crash, honest "nothing yet").
 */
export function buildFirstBrief(events: BriefEvent[], now: Date): FirstBrief {
  const valid = (events ?? []).filter((e) => e && typeof e.start === 'string' && Number.isFinite(Date.parse(e.start)));
  const nowMs = now.getTime();
  const weekEndMs = nowMs + 7 * DAY_MS;
  const todayKey = now.toISOString().slice(0, 10);

  // Sort by start so timelines and conflict scans are stable.
  const sorted = [...valid].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Today's timeline (all-day first, then chronological).
  const today = sorted.filter((e) => utcDayKey(e.start) === todayKey);
  const timeline: TimelineItem[] = [
    ...today.filter((e) => e.allDay),
    ...today.filter((e) => !e.allDay),
  ].map((e) => ({
    title: e.title,
    start: e.start,
    end: e.end ?? null,
    allDay: !!e.allDay,
    location: e.location ?? null,
    timeLabel: e.allDay ? 'All day' : fmtTime(e.start),
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
      if (utcDayKey(a.start) !== utcDayKey(b.start)) continue;
      const aStart = Date.parse(a.start), aEnd = endOf(a);
      const bStart = Date.parse(b.start), bEnd = endOf(b);
      if (aStart < bEnd && bStart < aEnd) {
        conflicts.push({
          aTitle: a.title,
          bTitle: b.title,
          dayLabel: dayLabel(a.start, now),
          overlapLabel: fmtRange(new Date(Math.max(aStart, bStart)).toISOString(), Math.min(aEnd, bEnd)),
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
    });
  }
  const tomorrowKey = new Date(nowMs + DAY_MS).toISOString().slice(0, 10);
  const missingLocation = week.filter((e) => !e.location && (utcDayKey(e.start) === todayKey || utcDayKey(e.start) === tomorrowKey));
  for (const e of missingLocation.slice(0, 3)) {
    actions.push({
      id: `location:${e.title}:${e.start}`,
      kind: 'location',
      label: `Add a location`,
      detail: `“${e.title}” ${dayLabel(e.start, now).toLowerCase()} has no place set.`,
    });
  }
  if (timeline.length > 0 && actions.length < 6) {
    const first = timeline.find((t) => !t.allDay) ?? timeline[0];
    actions.push({
      id: `prep:${first.title}`,
      kind: 'prep',
      label: 'Get ready for today',
      detail: `First up: ${first.title}${first.timeLabel !== 'All day' ? ` at ${first.timeLabel}` : ''}.`,
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
    });
  }
  if (conflicts.length > 0) {
    opportunities.push({
      id: 'conflicts',
      label: `${conflicts.length} clash${conflicts.length === 1 ? '' : 'es'} caught for you`,
      detail: 'We spotted these before they became a scramble.',
      minutes: conflicts.length * 15,
    });
  }
  if (week.length > 0) {
    opportunities.push({
      id: 'week',
      label: 'Your week, already organized',
      detail: `${week.length} event${week.length === 1 ? '' : 's'} sorted into one shared timeline.`,
      minutes: Math.min(week.length, 40) * 2,
    });
  }
  const top = opportunities.sort((a, b) => b.minutes - a.minutes).slice(0, 3);
  const timeSavedMinutes = top.reduce((s, o) => s + o.minutes, 0);

  // Headline.
  const dow = WEEKDAYS_LONG[now.getUTCDay()];
  let headline: string;
  if (timeline.length === 0 && week.length === 0) {
    headline = "You're set up — add your first plans and Bubaly takes it from here.";
  } else if (conflicts.length > 0) {
    headline = `Here's your ${dow} — ${timeline.length} event${timeline.length === 1 ? '' : 's'}, ${conflicts.length} clash${conflicts.length === 1 ? '' : 'es'} to resolve.`;
  } else {
    headline = `Here's your ${dow} — ${timeline.length} event${timeline.length === 1 ? '' : 's'}, and you're in good shape.`;
  }

  return {
    now: now.toISOString(),
    headline,
    todayCount: timeline.length,
    weekCount: week.length,
    timeline,
    conflicts,
    actions: actions.slice(0, 6),
    opportunities: top,
    timeSavedMinutes,
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
    timeSavedMinutes: brief.timeSavedMinutes,
    opportunities: brief.opportunities.map((o) => ({ label: o.label, minutes: o.minutes })),
  };
}
