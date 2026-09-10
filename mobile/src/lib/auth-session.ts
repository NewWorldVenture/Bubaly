import { isRetryableAuthError } from './auth-core';

/** Bootstrap and recovery reads are older than explicit auth events.
 * INITIAL_SESSION null is not proof of sign-out: an unavailable device store or
 * an offline bootstrap can still hold a valid refresh token. */
export function connectAuthSession<Session>(deps: {
  read: () => Promise<{ session: Session | null; error: unknown }>;
  subscribe: (listener: (event: string, session: Session | null) => void) => () => void;
  session: (session: Session | null) => void;
  restoring: (restoring: boolean) => void;
  ready: (ready: boolean) => void;
}) {
  let alive = true;
  let explicitEvent = false;
  let generation = 0;
  let restoring = false;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const unsubscribe = deps.subscribe((event, next) => {
    if (!alive || (event === 'INITIAL_SESSION' && (explicitEvent || !next))) return;
    explicitEvent = true;
    generation += 1; restoring = false; clearRetry();
    deps.session(next); deps.restoring(false); deps.ready(true);
  });
  const readSession = (): Promise<void> => {
    if (!alive) return Promise.resolve();
    if (pending) return pending;
    const started = generation;
    clearRetry();
    // Start on a microtask so even a synchronous read failure has an assigned
    // pending promise and cannot leave the single-flight guard stuck.
    pending = Promise.resolve().then(async () => {
      try {
        const result = await deps.read();
        if (!alive || started !== generation) return;
        deps.session(result.session);
        restoring = !result.session && isRetryableAuthError(result.error);
        deps.restoring(restoring);
      } catch (error) {
        if (!alive || started !== generation) return;
        restoring = isRetryableAuthError(error); deps.restoring(restoring);
      } finally {
        pending = null;
        if (alive) {
          deps.ready(true);
          // A readable, unexpired token does not cause an SDK refresh event.
          // Keep checking unavailable bootstrap storage until it is readable.
          if (restoring) timer = setTimeout(() => { timer = null; void readSession(); }, 30_000);
        }
      }
    });
    return pending;
  };
  const settled = explicitEvent ? Promise.resolve() : readSession();
  return {
    settled,
    retry: () => restoring ? readSession() : Promise.resolve(),
    dispose: () => { alive = false; clearRetry(); unsubscribe(); },
  };
}
