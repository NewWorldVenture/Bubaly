// lib/autopilot/cron-rotation.ts — where the daily Autopilot pass starts.
//
// The cron reads every family (ordered by id) and stops starting new ones when
// its time budget runs out, so whoever sits after the cut-off waits for a run
// that starts closer to them. Rotating the start by ONE family per day moved
// that cut-off by one family a day: with 5,000 families and ~500 scanned per
// run, a family past the cut-off waited about 4,500 days.
//
// No per-family "last scanned" signal exists to order by: `families` has no
// such column, nothing logs a scan, and `max(created_at)` of
// `autopilot_suggestions` only moves when a scan finds something new (and
// would need a grouped read of every suggestion). So the start is spread
// instead, without knowing how many families a run will reach:
//
// Run d starts at floor(N × vdc(d)), where vdc is the base-2 van der Corput
// sequence (the bits of d mirrored behind the binary point). Any 2^k
// consecutive runs have exactly one start in each N/2^k-wide slice of the
// ring, so no two neighbouring starts are more than 2N/2^k apart. A run that
// reaches C families therefore covers every gap once 2^k ≥ 2N/C: every family
// is reached within 4·N/C runs, whatever C turns out to be — 40 runs for
// 5,000 families at 500 a run, instead of 4,500. A fixed "advance by one
// batch" stride needs C known in advance, and a stride larger than the real C
// can skip the same families for good.
//
// Pure, so the bound is unit-tested without a database or a clock.

/** Base-2 van der Corput: the low 32 bits of `index` mirrored into [0, 1). */
export function vanDerCorput(index: number): number {
  let n = Math.max(0, Math.floor(index)) >>> 0;
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    reversed = (reversed << 1) | (n & 1);
    n >>>= 1;
  }
  return (reversed >>> 0) / 2 ** 32;
}

/** The index run `runIndex` starts at, among `n` families. */
export function rotationOffset(n: number, runIndex: number): number {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.floor(vanDerCorput(runIndex) * n));
}

/** `items` rotated to start where run `runIndex` should. */
export function rotateForRun<T>(items: readonly T[], runIndex: number): T[] {
  const offset = rotationOffset(items.length, runIndex);
  return [...items.slice(offset), ...items.slice(0, offset)];
}
