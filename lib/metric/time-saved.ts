// Modeled planning time for recorded completed plans. The historical handled
// vocabulary below remains available to history readers; the live metric uses
// the stricter completed-plans loader and never sums activity or reminders.
import type { AiRunLifecycleState } from '@/lib/database.types';
import { LEGACY_RUN_STATUS_TO_STATE } from '@/lib/ai/runs/states';
import { MODELED_MINUTES_PER_COMPLETED_PLAN } from './completed-plans-model';

/** What kind of handled action a count came from. */
export type SavedKind = 'run';

/**
 * The run lifecycle states that mean Bubaly actually finished something.
 *
 * `partially_completed` counts: the family got real work done even though not
 * every step landed, and §29 says a partial is reported honestly rather than
 * hidden. Nothing in-flight counts, and `failed` / `blocked` / `cancelled`
 * never count — those are the states a claim would be a lie about.
 */
export const HANDLED_RUN_STATES: readonly AiRunLifecycleState[] = ['completed', 'partially_completed'] as const;

/**
 * THE `state` COLUMN IS NOT ENOUGH, and assuming it was is what made this count
 * wrong. `family_automation_runs` carries two vocabularies: the §10 `state`
 * 0250 added, and the free-text `status` 0022 shipped, which the concierge
 * surfaces still write. `executeQueuedRunAction`
 * (app/(app)/dashboard/concierge/actions.ts) materialises the plan a manager
 * tapped "Do it" on and stamps ONLY `status = 'executed'`, leaving the row at
 * the `state = 'awaiting_approval'` it was inserted with; and 0250 documents
 * that every row written before it keeps the default `state = 'queued'` with a
 * meaningful `status`. A count filtered on `state` alone therefore reads zero
 * for a panel that is, one line lower, listing the very plan it just ran.
 *
 * So "handled" is decided by the run's EFFECTIVE state — `state` when it says
 * something, otherwise the legacy `status` translated through
 * `LEGACY_RUN_STATUS_TO_STATE`, the repo's one mapping between the two columns.
 * These are the legacy values that translate to a handled state (today:
 * `executed` → `completed`); deriving them from the map rather than writing
 * them out again means adding a status there is enough.
 */
export const HANDLED_LEGACY_RUN_STATUSES: readonly string[] = Object.entries(LEGACY_RUN_STATUS_TO_STATE)
  .filter(([, state]) => (HANDLED_RUN_STATES as readonly string[]).includes(state))
  .map(([status]) => status);

/**
 * The PostgREST `.or()` expression that selects exactly the rows `isHandledRun`
 * accepts, so the SQL every surface runs and the predicate the tests exercise
 * cannot drift apart. A row matching both halves is still ONE row, so a run
 * carrying `state = 'completed'` and `status = 'executed'` is counted once.
 */
export const HANDLED_RUN_OR_FILTER =
  `state.in.(${HANDLED_RUN_STATES.join(',')}),status.in.(${HANDLED_LEGACY_RUN_STATUSES.join(',')})`;

/** True when a run row is one the "handled" count may include — either column. */
export function isHandledRun(row: { state?: string | null; status?: string | null }): boolean {
  if ((HANDLED_RUN_STATES as readonly string[]).includes(row.state ?? '')) return true;
  return HANDLED_LEGACY_RUN_STATUSES.includes(row.status ?? '');
}

/** Modeling assumption, not measured time saved. */
const MINUTES: Record<SavedKind, number> = { run: MODELED_MINUTES_PER_COMPLETED_PLAN };
const LABEL: Record<SavedKind, string> = {
  run: 'recorded completed plans',
};
/** Catalogue keys for the same labels — the UI renders these, never `LABEL`. */
const LABEL_KEY: Record<SavedKind, string> = {
  run: 'timeSaved.plansBubalyRanEndToEnd',
};

/** Every kind, in the order a breakdown reads best. */
export const SAVED_KINDS: readonly SavedKind[] = ['run'] as const;

export interface SavedInput { kind: SavedKind; count: number }
export interface TimeSavedRow { kind: SavedKind; count: number; minutes: number; label: string; labelKey: string }
export interface TimeSaved {
  minutes: number;
  /** minutes rendered as hours to 1 decimal (e.g. 3.2). */
  hours: number;
  /** Dated recorded completed plans in the trailing week. */
  actions: number;
  /** All recorded completed plans with no completion date; excluded from this week. */
  undatedCompletedRuns: number;
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

/** Model planning time for the measured subset; no other activity is added. */
export function computeTimeSaved(inputs: SavedInput[], undatedCompletedRuns = 0): TimeSaved {
  const rows: TimeSavedRow[] = inputs
    .filter((i) => i.kind === 'run' && i.count > 0)
    .map((i) => ({
      kind: i.kind, count: i.count, minutes: i.count * MINUTES[i.kind],
      label: LABEL[i.kind], labelKey: LABEL_KEY[i.kind],
    }));
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  const actions = rows.reduce((s, r) => s + r.count, 0);
  const hours = Math.round(minutes / 6) / 10;
  const show = actions > 0 || undatedCompletedRuns > 0;
  const headline = `${actions} recorded completed plans in the last 7 days — ${humanizeSaved(minutes)} modeled planning time.`;
  return { minutes, hours, actions, undatedCompletedRuns, rows, headline, show };
}
