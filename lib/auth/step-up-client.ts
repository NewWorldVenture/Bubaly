// lib/auth/step-up-client.ts — the browser half of a server action's step-up
// refusal.
//
// app/(app)/dashboard/billing/actions.ts answers an `aal1` session of a parent
// who enrolled an authenticator with `{ ok: false, error, stepUp }` rather than
// a thrown redirect, because every caller awaits the action and checks `ok`,
// and a redirect thrown inside the action would be swallowed there. That answer
// is only half a fix unless the caller acts on `stepUp`: a toast that says
// "enter your code" with nowhere to enter it is a dead end. This is where the
// caller acts on it, so the seven money actions' call sites share one rule.
import { stepUpPath } from './mfa';

export type RefusedAction = { error: string; stepUp?: string };

/**
 * Show why the action was refused, and when the refusal was "enter your code
 * first", take the family to the step-up page and bring them back to the page
 * they were on — not to the one the server action happened to name, since the
 * same action is called from /dashboard/billing, /dashboard/savings and
 * /dashboard/budgets alike.
 *
 * `go` and `here` default to the browser's location and exist so the rule can
 * be tested without one.
 */
export function reportRefusal(
  res: RefusedAction,
  show: (message: string) => void,
  go: (to: string) => void = (to) => window.location.assign(to),
  here: () => string = () => `${window.location.pathname}${window.location.search}`,
): void {
  show(res.error);
  if (!res.stepUp) return;
  go(stepUpPath(here()));
}
