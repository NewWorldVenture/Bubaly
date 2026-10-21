import { restoreReason, restoreRetryDelay, type RestoreIssue } from './auth-core';

/** Bootstrap and recovery reads are older than explicit auth events.
 * INITIAL_SESSION null is not proof of sign-out: an unavailable device store or
 * an offline bootstrap can still hold a valid refresh token. */
export function connectAuthSession<Session>(deps: {
  read: () => Promise<{ session: Session | null; error: unknown }>;
  subscribe: (listener: (event: string, session: Session | null) => void) => () => void;
  session: (session: Session | null) => void;
  restoring: (restoring: boolean) => void;
  ready: (ready: boolean) => void;
  /** Why the session is still being restored, and for how many reads; null once it is not. */
  issue?: (issue: RestoreIssue | null) => void;
}) {
  let alive = true;
  let explicitEvent = false;
  let generation = 0;
  let restoring = false;
  let failures = 0;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const unsubscribe = deps.subscribe((event, next) => {
    if (!alive || (event === 'INITIAL_SESSION' && (explicitEvent || !next))) return;
    explicitEvent = true;
    generation += 1; restoring = false; failures = 0; clearRetry();
    deps.session(next); deps.restoring(false); deps.issue?.(null); deps.ready(true);
  });
  const settle = (error: unknown) => {
    const reason = restoreReason(error);
    restoring = reason !== null;
    failures = restoring ? failures + 1 : 0;
    deps.restoring(restoring);
    deps.issue?.(reason ? { reason, failures } : null);
  };
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
        settle(result.session ? null : result.error);
      } catch (error) {
        if (!alive || started !== generation) return;
        settle(error);
      } finally {
        pending = null;
        if (alive) {
          deps.ready(true);
          // A readable, unexpired token does not cause an SDK refresh event.
          // Keep checking unavailable bootstrap storage until it is readable —
          // backing off, because a store that could not be read a moment ago
          // rarely can be read now, and nothing rewrites it without a session.
          if (restoring) timer = setTimeout(() => { timer = null; void readSession(); }, restoreRetryDelay(failures));
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
