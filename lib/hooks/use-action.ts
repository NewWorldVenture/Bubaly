'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * useAction — a tiny primitive for safe, responsive async UI operations.
 *
 * Solves three recurring problems at once:
 *  1. **Duplicate / rapid-click guard** — a second call with the same `key`
 *     while the first is still in flight is ignored (a ref, so the guard is
 *     synchronous and not subject to React batching races).
 *  2. **Per-key busy state** — `isPending(key)` lets a button/row show a
 *     spinner or disabled state for exactly the item being mutated.
 *  3. **Centralised error handling** — pass `onError` once; any throw from the
 *     work function is caught and routed there (e.g. a toast).
 *
 * Use a stable `key` per logical target: an item id for list rows, or a fixed
 * string like `'save'` / `'delete'` for singletons.
 */
export function useAction(opts?: { onError?: (err: unknown) => void }) {
  const onError = opts?.onError;
  const [pending, setPending] = useState<Set<string>>(new Set());
  const inflight = useRef<Set<string>>(new Set());

  const run = useCallback(
    async (key: string, fn: () => Promise<void> | void): Promise<void> => {
      if (inflight.current.has(key)) return; // ignore concurrent duplicate
      inflight.current.add(key);
      setPending((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      try {
        await fn();
      } catch (err) {
        onError?.(err);
      } finally {
        inflight.current.delete(key);
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [onError],
  );

  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  return { run, isPending, anyPending: pending.size > 0 };
}
