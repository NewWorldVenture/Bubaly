// lib/i18n/sign-in-language.ts — how long a sign-in form waits for the
// OPTIONAL language step (syncLanguageAfterSignInAction) before it navigates
// anyway.
//
// The server bounds its own work (LANGUAGE_SYNC_BUDGET_MS in lib/i18n/sync.ts),
// but that cannot bound a server-action request that is queued or slow to
// start, or a response that never arrives. The person is already signed in by
// then, so the form must not wait on it (#705 comment 5923116178). After this
// deadline the form stops WAITING. Nothing is cancelled: a step the server has
// already started or accepted may still finish, and the next sign-in or switch
// puts the language in step again.
//
// Framework-free, so the client forms and the tests import it directly.

/** Longer than the server's 1.5 s budget, so an answering server is never cut short. */
export const SIGN_IN_LANGUAGE_WAIT_MS = 3000;

/**
 * Run an optional step and settle when it resolves, rejects or throws, or after
 * `ms`, whichever comes first. It never rejects: an optional step cannot fail a
 * sign-in.
 */
export function waitForOptionalStep(step: () => Promise<unknown>, ms: number = SIGN_IN_LANGUAGE_WAIT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    let running: Promise<unknown>;
    try {
      running = step();
    } catch {
      done();
      return;
    }
    Promise.resolve(running).then(done, done);
  });
}
