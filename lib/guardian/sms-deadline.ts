import 'server-only';

/** Stops the caller even when a custom transport ignores cancellation. */
export async function smsStep<T>(parent: AbortSignal | undefined, run: (signal: AbortSignal) => PromiseLike<T>, milliseconds = 5000): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(milliseconds), ...(parent ? [parent] : [])]);
  let abort = () => {};
  try {
    signal.throwIfAborted();
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Guardian SMS operation unavailable'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }), interrupted]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}
