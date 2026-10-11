import { describeActionError } from '@/lib/supabase/errors';

/**
 * Await a server action from a click handler without losing a rejection.
 *
 * A Next.js server-action call does not always come back as `{ ok: false }`: a
 * dropped connection, a timeout, a redeploy ("Failed to find Server Action") or
 * a throw before the action's own try all REJECT the promise. Awaited bare in an
 * onClick, that rejection is unhandled — no toast, no refresh — and the person
 * cannot tell whether the row is gone, because the write may already have
 * committed on the server.
 *
 * Returns the action's result, or `null` after it has told the person and
 * re-read the list so the screen shows what the server actually holds.
 */
export async function settleAction<R>(
  call: () => Promise<R>,
  fallback: string,
  report: (message: string) => void,
  refresh?: () => unknown,
): Promise<R | null> {
  try {
    return await call();
  } catch (err) {
    console.error('[action] request failed before it answered', err);
    report(describeActionError(err, fallback));
    void refresh?.();
    return null;
  }
}
