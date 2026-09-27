/**
 * `Promise.all(items.map(work))` with a ceiling on how many run at once.
 *
 * `Promise.all` over a mapped array starts EVERY item immediately. For pure
 * work that is free; for anything that leaves the process it is a fan-out
 * whose width is whatever the data happens to be. A family with two hundred
 * located events on their calendar opened two hundred simultaneous requests to
 * an external routing provider — a rate-limit, a bill, and a thundering herd,
 * all decided by a number nobody chose (F-F09).
 *
 * Order is preserved: `results[i]` is `work(items[i])`, whatever order they
 * finished in. A caller that zips results back onto its inputs by index —
 * which is the usual reason to want a mapped array at all — stays correct.
 *
 * Rejection behaves like `Promise.all`: the first rejection wins and the rest
 * are left to settle. This is deliberately NOT a "settle everything" helper,
 * because swallowing a failure here would put a `undefined` into a results
 * array a caller reads positionally. A caller that wants tolerance catches
 * inside `work`, where it knows what a miss means — which is what the drive
 * -time fetcher does.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.trunc(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  // One worker per lane, each pulling the next index until there are none.
  // A lane rather than a chunk: chunking waits for the slowest item in each
  // batch before starting the next, so a single slow call idles the rest.
  async function lane(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return results;
}
