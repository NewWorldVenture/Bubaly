'use client';

import * as ReactDOM from 'react-dom';

/**
 * A submit button that knows its own form is in flight.
 *
 * `<form action={serverAction}>` stays interactive while the action runs, so a
 * second click submits again — and a server action is not idempotent unless it
 * was written to be. Across the admin marketing console that meant two campaigns,
 * two segments, two blog entries from one impatient double-click; on the handful
 * of family-facing forms it meant a duplicate row or a second model call.
 *
 * `useFormStatus` reads the status of the form this button is rendered INSIDE,
 * which is why this is its own client component rather than a hook in the page:
 * the hook returns `pending: false` if called by the component that renders the
 * `<form>` itself. Every submit in the form disables together, which is correct
 * for a form with more than one action — one of them is running.
 *
 * WHY THE HOOK IS RESOLVED DEFENSIVELY. `package.json` declares react-dom
 * ^18.3.1, which has no `useFormStatus` — it arrived in React 19. The app works
 * because Next 15 bundles its own React 19 build and aliases `react-dom` to it
 * for App Router code; vitest does not, and resolves the hoisted 18.3.1. So the
 * same component sees two different react-doms depending on who is rendering it.
 * That split is a finding of its own (the declared dependency does not describe
 * what production runs); until it is closed, this reads the hook once at module
 * load, so the call below is unconditional within any given build and the button
 * degrades to a plain submit where the hook does not exist.
 */
const formStatus = (ReactDOM as { useFormStatus?: () => { pending: boolean } }).useFormStatus;
const usePending = formStatus ? () => formStatus().pending : () => false;

export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: React.ComponentProps<'button'> & {
  /** Shown while the form is in flight. Defaults to the button's own label. */
  pendingLabel?: React.ReactNode;
}) {
  const pending = usePending();
  return (
    <button
      {...props}
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending || undefined}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
