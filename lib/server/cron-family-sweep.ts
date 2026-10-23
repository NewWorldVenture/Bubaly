// A budgeted, rotated, bounded-concurrency pass over every family.
//
// Several crons walk `families` in `order('id')` and await one family at a
// time with no budget, no per-family timeout and no cursor, and only AFTER the
// loop do the delivery steps run. Killed at the platform's function limit, such
// a run serves the same prefix every day, never reaches the same tail, delivers
// nothing that tick and leaves no response to count it (weekly-digest and
// chore-reminders documented and fixed exactly this; the notifications,
// push-scan and guardian-learning routes had not been given the same treatment).
//
// This is the shared shape: start where this run should (lib/autopilot/
// cron-rotation.ts, so a cut-off moves and every family is reached within a
// bounded number of runs), run a few families at once against latency, give
// each family a timeout so one hung read is that family's failure and not the
// run's, stop STARTING families once the budget is spent, and hand back the
// families that were never attempted so the caller can report them and answer
// 502 — an unserved tail must not look like a clean run.
import { rotateForRun, rotateForSlot } from '@/lib/autopilot/cron-rotation';

export type SweepOptions = {
  /** Stop starting new items once this much time has passed since `startedAt`. */
  budgetMs: number;
  /** One item's allowance; past it the item is reported as timed out and the pass moves on. */
  itemTimeoutMs: number;
  concurrency: number;
  /** Which run this is, for the rotation; defaults to the hour. */
  runIndex?: number;
  /**
   * For a cron with several fixed slots a day (lib/server/cron-slot.ts
   * lastDailySlot): `runIndex` then names the DAY, and run `index` of `of`
   * starts that share of the ring further on (rotateForSlot), so the day's
   * second run does not re-serve the first run's prefix.
   */
  slot?: { index: number; of: number };
  startedAt?: number;
};

export type SweepResult<T> = {
  /** Items the pass never started: the budget ran out first. */
  unreached: T[];
  /** Items whose work outlived its timeout; their late result was not counted. */
  timedOut: T[];
};

/**
 * `work(item, counted)` does and counts its own work; it reads `counted.current`
 * before touching any counter, because a result that arrives after the timeout
 * has already been counted as a timeout.
 */
export async function sweepFamilies<T>(
  items: readonly T[],
  opts: SweepOptions,
  work: (item: T, counted: { current: boolean }) => Promise<void>,
): Promise<SweepResult<T>> {
  const startedAt = opts.startedAt ?? Date.now();
  const runIndex = opts.runIndex ?? Math.floor(startedAt / 3_600_000);
  const queue = opts.slot
    ? rotateForSlot(items, { day: runIndex, slot: opts.slot.index }, opts.slot.of)
    : rotateForRun(items, runIndex);
  const unreached: T[] = [];
  const timedOut: T[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (Date.now() - startedAt >= opts.budgetMs) { unreached.push(item); continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), opts.itemTimeoutMs); });
      const counted = { current: true };
      const outcome = await Promise.race([work(item, counted).then(() => 'done' as const, () => 'done' as const), expired]);
      clearTimeout(timer);
      if (outcome === 'timeout') { counted.current = false; timedOut.push(item); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, queue.length)) }, worker));
  return { unreached, timedOut };
}
