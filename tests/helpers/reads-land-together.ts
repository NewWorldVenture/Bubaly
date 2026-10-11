import type { InMemorySupabase } from './in-memory-supabase';

/**
 * Hold the first `n` reads of `table` until all `n` have been answered, so `n`
 * concurrent callers all decide from the same snapshot before any of them
 * writes — the interleaving two requests on two servers actually get, made
 * deterministic instead of left to microtask order.
 *
 * Only `select`s are held; writes to the table pass straight through.
 */
export function readsLandTogether(db: InMemorySupabase, table: string, n: number): void {
  let arrived = 0;
  let release!: () => void;
  const together = new Promise<void>((resolve) => { release = resolve; });
  const hold = async <T>(builder: unknown, reply: T): Promise<T> => {
    if ((builder as { op?: string }).op === 'select' && arrived < n) {
      arrived += 1;
      if (arrived === n) release();
      await together;
    }
    return reply;
  };
  const from = db.from.bind(db);
  db.from = ((name: string) => {
    const builder = from(name);
    if (name !== table) return builder;
    const b = builder as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const terminal of ['maybeSingle', 'single'] as const) {
      const original = b[terminal].bind(builder);
      b[terminal] = () => original().then((reply) => hold(builder, reply));
    }
    const then = b.then.bind(builder);
    b.then = (onFulfilled?: unknown, onRejected?: unknown) =>
      then((reply: unknown) => hold(builder, reply))
        .then(onFulfilled as never, onRejected as never);
    return builder;
  }) as typeof db.from;
}
