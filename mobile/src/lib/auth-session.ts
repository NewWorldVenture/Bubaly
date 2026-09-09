import { isRetryableAuthError } from './auth-core';

/** Bootstrap is older than every explicit auth event. INITIAL_SESSION null is
 * not proof of sign-out: an offline bootstrap can still hold a refresh token. */
export function connectAuthSession<Session>(deps: {
  read: () => Promise<{ session: Session | null; error: unknown }>;
  subscribe: (listener: (event: string, session: Session | null) => void) => () => void;
  session: (session: Session | null) => void;
  restoring: (restoring: boolean) => void;
  ready: (ready: boolean) => void;
}) {
  let alive = true;
  let explicitEvent = false;
  const unsubscribe = deps.subscribe((event, next) => {
    if (!alive || (event === 'INITIAL_SESSION' && (explicitEvent || !next))) return;
    explicitEvent = true;
    deps.session(next); deps.restoring(false); deps.ready(true);
  });
  const settled = (async () => {
    try {
      const result = await deps.read();
      if (!alive || explicitEvent) return;
      deps.session(result.session);
      deps.restoring(!result.session && isRetryableAuthError(result.error));
    } catch (error) {
      if (alive && !explicitEvent) deps.restoring(isRetryableAuthError(error));
    } finally { if (alive) deps.ready(true); }
  })();
  return { settled, dispose: () => { alive = false; unsubscribe(); } };
}
