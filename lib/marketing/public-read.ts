import 'server-only';

export const PUBLIC_READ_BUDGET_MS = 4_000;

/**
 * A deadline for optional public presentation data, never an authorization gate.
 * Abort alone cannot bound an SDK token lookup or a transport/body that ignores
 * the signal, so the caller also races the complete read. A late result cannot
 * turn this rejected read into a successful unstable_cache value.
 * This bounds the read callback, not Next's cache backend or an entire page.
 */
export async function withPublicReadBudget<T>(read: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Optional public data exceeded its read budget');
      reject(error);
      controller.abort(error);
    }, PUBLIC_READ_BUDGET_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
