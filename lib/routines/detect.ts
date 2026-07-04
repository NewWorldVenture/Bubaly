// lib/routines/detect.ts — pure, deterministic helpers for recurring-routine
// templates (Friction #10). No React/Supabase — just data in, data out, so the
// detection + materialization logic is fully unit-testable.
//
// A "routine" is a bundle of related events that repeats on a set of weekdays.
// We DETECT candidate routines from the family's calendar history (same title +
// same weekday + same time-of-day appearing on multiple distinct weeks), and we
// MATERIALIZE a saved template into concrete calendar_events for a date range.

export type EventCategory =
  | 'general' | 'school' | 'sports' | 'appointment' | 'medication'
  | 'maintenance' | 'birthday' | 'holiday' | 'other';

/** Minimal event shape the detector needs (subset of calendar_events). */
export interface RoutineEventInput {
  id: string;
  title: string;
  category: EventCategory;
  starts_at: string;       // ISO
  ends_at: string | null;  // ISO
  all_day: boolean;
  assignee_id: string | null;
}

export interface RoutineSuggestion {
  /** Stable signature = normalizedTitle | weekday | startBucket. */
  signature: string;
  title: string;
  category: EventCategory;
  weekday: number;         // 0=Mon … 6=Sun
  startMinutes: number;    // minutes from midnight (rounded to bucket)
  durationMinutes: number; // median observed duration
  assigneeId: string | null;
  occurrences: number;     // distinct weeks seen
  lastSeen: string;        // ISO of most recent occurrence
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** JS getDay() (0=Sun) → app weekday (0=Mon … 6=Sun). */
export function jsDayToWeekday(jsDay: number): number { return (jsDay + 6) % 7; }

/** ISO week key "YYYY-Www" so occurrences are counted per distinct week. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface DetectOptions {
  /** Round start times into buckets so 7:58 and 8:02 group together. Default 30. */
  bucketMinutes?: number;
  /** Minimum distinct weeks before something counts as a routine. Default 3. */
  minOccurrences?: number;
  /** Cap on how many suggestions to return (most-frequent first). Default 6. */
  limit?: number;
}

/**
 * Detect recurring single-event routines from history. Groups timed events by
 * (normalized title, weekday, start-bucket); any group seen on ≥ minOccurrences
 * distinct weeks becomes a suggestion. Deterministic; ignores all-day events.
 */
export function detectRoutines(events: RoutineEventInput[], opts: DetectOptions = {}): RoutineSuggestion[] {
  const bucket = opts.bucketMinutes ?? 30;
  const minOcc = opts.minOccurrences ?? 3;
  const limit = opts.limit ?? 6;

  type Group = {
    title: string; category: EventCategory; weekday: number; startBucket: number;
    weeks: Set<string>; durations: number[]; assignees: Map<string, number>;
    lastSeen: number; titleSamples: Map<string, number>;
  };
  const groups = new Map<string, Group>();

  for (const e of events) {
    if (e.all_day) continue;
    const start = new Date(e.starts_at);
    if (Number.isNaN(start.getTime())) continue;
    const weekday = jsDayToWeekday(start.getDay());
    const minutes = start.getHours() * 60 + start.getMinutes();
    const startBucket = Math.round(minutes / bucket) * bucket;
    const key = `${normalizeTitle(e.title)}|${weekday}|${startBucket}`;

    let g = groups.get(key);
    if (!g) {
      g = { title: e.title.trim(), category: e.category, weekday, startBucket, weeks: new Set(), durations: [], assignees: new Map(), lastSeen: 0, titleSamples: new Map() };
      groups.set(key, g);
    }
    g.weeks.add(isoWeekKey(start));
    if (e.ends_at) {
      const dur = (new Date(e.ends_at).getTime() - start.getTime()) / 60000;
      if (dur > 0 && dur <= 1440) g.durations.push(Math.round(dur));
    }
    if (e.assignee_id) g.assignees.set(e.assignee_id, (g.assignees.get(e.assignee_id) ?? 0) + 1);
    g.titleSamples.set(e.title.trim(), (g.titleSamples.get(e.title.trim()) ?? 0) + 1);
    g.lastSeen = Math.max(g.lastSeen, start.getTime());
  }

  const suggestions: RoutineSuggestion[] = [];
  for (const [signature, g] of groups) {
    if (g.weeks.size < minOcc) continue;
    // Most common exact title casing wins for display.
    const title = [...g.titleSamples.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const assigneeId = g.assignees.size
      ? [...g.assignees.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;
    suggestions.push({
      signature, title, category: g.category, weekday: g.weekday,
      startMinutes: g.startBucket,
      durationMinutes: median(g.durations) || 30,
      assigneeId, occurrences: g.weeks.size,
      lastSeen: new Date(g.lastSeen).toISOString(),
    });
  }

  suggestions.sort((a, b) => b.occurrences - a.occurrences || a.startMinutes - b.startMinutes);
  return suggestions.slice(0, limit);
}

// ── weekday-mask helpers (bit 0 = Mon … bit 6 = Sun) ────────────────────────

export const WEEKDAYS_ALL = 0b1111111;   // 127
export const WEEKDAYS_WEEKDAYS = 0b0011111; // Mon–Fri = 31
export const WEEKDAYS_WEEKEND = 0b1100000;  // Sat+Sun = 96

export function hasWeekday(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}
export function toggleWeekday(mask: number, weekday: number): number {
  return mask ^ (1 << weekday);
}
export function weekdaysInMask(mask: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < 7; w++) if (hasWeekday(mask, w)) out.push(w);
  return out;
}

/** Friendly label: "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". */
export function weekdayMaskLabel(mask: number): string {
  const m = mask & WEEKDAYS_ALL;
  if (m === WEEKDAYS_ALL) return 'Every day';
  if (m === WEEKDAYS_WEEKDAYS) return 'Weekdays';
  if (m === WEEKDAYS_WEEKEND) return 'Weekends';
  if (m === 0) return 'No days';
  return weekdaysInMask(m).map((w) => WEEKDAY_LABELS[w]).join(', ');
}

export function weekdayLong(weekday: number): string { return WEEKDAY_LONG[weekday] ?? ''; }

export function minutesToLabel(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── materialization ─────────────────────────────────────────────────────────

export interface RoutineTemplateForApply {
  weekday_mask: number;
  items: {
    title: string; category: EventCategory;
    start_minutes: number; duration_minutes: number; assignee_id: string | null;
  }[];
}

export interface MaterializedEvent {
  title: string; category: EventCategory;
  starts_at: string; ends_at: string; all_day: false;
  assignee_id: string | null;
}

/** Local Date at a given weekday within the week containing `weekStartMonday`. */
function dateForWeekday(weekStartMonday: Date, weekday: number, minutes: number): Date {
  const d = new Date(weekStartMonday);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + weekday);
  d.setMinutes(minutes);
  return d;
}

/**
 * Expand a template into concrete events for the given number of weeks starting
 * at `weekStartMonday` (a Monday, local midnight). Emits one event per
 * (active weekday × item × week). Deterministic; returns Insert-ready rows
 * (caller adds family_id / created_by / recurrence:'none').
 */
export function materializeRoutine(
  template: RoutineTemplateForApply,
  weekStartMonday: Date,
  weeks = 1,
): MaterializedEvent[] {
  const days = weekdaysInMask(template.weekday_mask);
  const out: MaterializedEvent[] = [];
  for (let w = 0; w < weeks; w++) {
    const base = new Date(weekStartMonday);
    base.setDate(base.getDate() + w * 7);
    for (const weekday of days) {
      for (const item of template.items) {
        const start = dateForWeekday(base, weekday, item.start_minutes);
        const end = new Date(start.getTime() + item.duration_minutes * 60000);
        out.push({
          title: item.title, category: item.category,
          starts_at: start.toISOString(), ends_at: end.toISOString(),
          all_day: false, assignee_id: item.assignee_id,
        });
      }
    }
  }
  return out;
}
