'use client';

import { useFormStatus } from 'react-dom';

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
 */

export function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: React.ComponentProps<'button'> & {
  /** Shown while the form is in flight. Defaults to the button's own label. */
  pendingLabel?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
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
