// lib/metric/time-saved.ts — R11: the category metric (pure, unit-tested).
//
// The whole thesis rests on ONE number: not daily active users, but *time / mental
// load removed*. This turns the family's system-handled actions this week — tasks
// Autopilot executed, items the assistants handled, reminders delivered — into a
// real "I saved you ~N hours this week" figure with a transparent breakdown. Pure
// so it's testable; the page/loader supplies the live counts.

export type SavedKind = 'autopilot' | 'assistant' | 'reminder';

/** Minutes of family admin saved per handled action of each kind (conservative). */
const MINUTES: Record<SavedKind, number> = { autopilot: 5, assistant: 4, reminder: 2 };
const LABEL: Record<SavedKind, string> = {
  autopilot: 'tasks auto-handled',
  assistant: 'items your assistants handled',
  reminder: 'reminders delivered',
};

export interface SavedInput { kind: SavedKind; count: number }
export interface TimeSavedRow { kind: SavedKind; count: number; minutes: number; label: string }
export interface TimeSaved {
  minutes: number;
  /** minutes rendered as hours to 1 decimal (e.g. 3.2). */
  hours: number;
  /** total actions handled for the family. */
  actions: number;
  rows: TimeSavedRow[];
  headline: string;
  /** false when nothing was handled — the surface can hide. */
  show: boolean;
}

/** Human duration: "about 3.2 hours" / "about 40 minutes". */
export function humanizeSaved(minutes: number): string {
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 6) / 10;
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Compute time saved from this week's system-handled action counts. */
export function computeTimeSaved(inputs: SavedInput[]): TimeSaved {
  const rows: TimeSavedRow[] = inputs
    .filter((i) => i.count > 0)
    .map((i) => ({ kind: i.kind, count: i.count, minutes: i.count * MINUTES[i.kind], label: LABEL[i.kind] }));
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  const actions = rows.reduce((s, r) => s + r.count, 0);
  const hours = Math.round(minutes / 6) / 10;
  const show = actions > 0;
  const headline = show
    ? `I saved you ${humanizeSaved(minutes)} this week — ${actions} ${actions === 1 ? 'thing' : 'things'} handled for you.`
    : "I'll start saving you time as your family leans on Bubaly.";
  return { minutes, hours, actions, rows, headline, show };
}
