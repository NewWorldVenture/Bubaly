// A deadline for one request.
//
// React Native's Android fetch runs on an OkHttp client built with no connect,
// read or write timeout, so a socket black-holed by a network switch never
// rejects: the assistant sat on "Bubaly is thinking…", the calendar on a blank
// loading list and the Chores and Grocery tabs on their initial blank state
// until the person tapped Stop, pulled or navigated away. iOS gives up on its
// own at about 60 s. Each transport now links its caller's signal (Stop, a
// newer load, leaving the screen) with a timer, and tells a timeout apart from
// the caller's own abort so it can be shown as "taking longer than expected"
// with a retry. Pure — unit-tested from the repo root.

/** Both AI routes bound their provider calls at 60 s (maxDuration 60), so the server's own answer arrives first. */
export const ASSISTANT_DEADLINE_MS = 75_000;
/** A read of a few rows, over the calendar route or straight from PostgREST. */
export const READ_DEADLINE_MS = 20_000;

export type Deadline = {
  signal: AbortSignal;
  /** True once the timer, not the caller, aborted the request. */
  timedOut: () => boolean;
  /** Stop the timer and detach from the caller's signal; call once the response is read. */
  clear: () => void;
};

export function withDeadline(signal: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const follow = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', follow, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => { clearTimeout(timer); signal?.removeEventListener('abort', follow); },
  };
}
