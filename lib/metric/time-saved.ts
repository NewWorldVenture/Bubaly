// lib/metric/time-saved.ts — R11: the category metric (pure, unit-tested).
//
// The whole thesis rests on ONE number: not daily active users, but *time /
// mental load removed*. This turns the family's system-handled actions this
// week — plans Bubaly ran end to end, tasks Autopilot executed, items the
// assistants handled, reminders delivered — into a real "I saved you ~N hours
// this week" figure with a transparent breakdown. Pure so it's testable; the
// loader (`lib/metric/time-saved-server.ts`) supplies the live counts.
//
// THIS FILE IS THE ONE DEFINITION of "handled". Three surfaces used to hold
// three different answers — the Autopilot panel counted `family_automation_runs`
// with `trigger_type = 'plan_accepted'` and the legacy `status = 'executed'`,
// the Daily Brief counted the LENGTH OF A LIST that `mergeCompletedByBubaly`
// caps at six, and time-saved counted three other tables and no runs at all. A
// family could therefore read "3 handled" and "7 handled" on two screens of the
// same product, both true to their own arithmetic and neither true to the
// household. `HANDLED_RUN_STATES` and `SAVED_KINDS` are now the single
// vocabulary; everything else reads from here.

import type { AiRunLifecycleState } from '@/lib/database.types';

/** What kind of handled action a count came from. */
export type SavedKind = 'run' | 'autopilot' | 'assistant' | 'reminder';

/**
 * The run lifecycle states that mean Bubaly actually finished something.
 *
 * `partially_completed` counts: the family got real work done even though not
 * every step landed, and §29 says a partial is reported honestly rather than
 * hidden. Nothing in-flight counts, and `failed` / `blocked` / `cancelled`
 * never count — those are the states a claim would be a lie about.
 *
 * Deliberately the `state` column (the §10 lifecycle) and not the legacy
 * free-text `status`: `state` is the one every writer in the AI runtime sets.
 */
export const HANDLED_RUN_STATES: readonly AiRunLifecycleState[] = ['completed', 'partially_completed'] as const;

/** True when a run row is one the "handled" count may include. */
export function isHandledRun(row: { state?: string | null }): boolean {
  return (HANDLED_RUN_STATES as readonly string[]).includes(row.state ?? '');
}

/** Minutes of family admin saved per handled action of each kind (conservative). */
const MINUTES: Record<SavedKind, number> = { run: 12, autopilot: 5, assistant: 4, reminder: 2 };
const LABEL: Record<SavedKind, string> = {
  run: 'plans Bubaly ran end to end',
  autopilot: 'tasks auto-handled',
  assistant: 'items your assistants handled',
  reminder: 'reminders delivered',
};
/** Catalogue keys for the same labels — the UI renders these, never `LABEL`. */
const LABEL_KEY: Record<SavedKind, string> = {
  run: 'timeSaved.plansBubalyRanEndToEnd',
  autopilot: 'timeSaved.tasksAutoHandled',
  assistant: 'timeSaved.itemsYourAssistantsHandled',
  reminder: 'timeSaved.remindersDelivered',
};

/** Every kind, in the order a breakdown reads best. */
export const SAVED_KINDS: readonly SavedKind[] = ['run', 'autopilot', 'assistant', 'reminder'] as const;

export interface SavedInput { kind: SavedKind; count: number }
export interface TimeSavedRow { kind: SavedKind; count: number; minutes: number; label: string; labelKey: string }
export interface TimeSaved {
  minutes: number;
  /** minutes rendered as hours to 1 decimal (e.g. 3.2). */
  hours: number;
  /** total actions handled for the family — the ONE handled-this-week number. */
  actions: number;
  rows: TimeSavedRow[];
  headline: string;
  /** false when nothing was handled — the surface can hide. */
  show: boolean;
}

/**
 * What a loader answers.
 *
 * `available: false` is NOT "zero". A surface handed an unavailable result must
 * say the number could not be read and offer a retry; it must never fall back
 * to 0, which is a claim about the household rather than about the database.
 */
export type TimeSavedResult = { available: true; data: TimeSaved } | { available: false };

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
    .map((i) => ({
      kind: i.kind, count: i.count, minutes: i.count * MINUTES[i.kind],
      label: LABEL[i.kind], labelKey: LABEL_KEY[i.kind],
    }));
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  const actions = rows.reduce((s, r) => s + r.count, 0);
  const hours = Math.round(minutes / 6) / 10;
  const show = actions > 0;
  const headline = show
    ? `I saved you ${humanizeSaved(minutes)} this week — ${actions} ${actions === 1 ? 'thing' : 'things'} handled for you.`
    : "I'll start saving you time as your family leans on Bubaly.";
  return { minutes, hours, actions, rows, headline, show };
}
