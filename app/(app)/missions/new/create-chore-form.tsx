'use client';

import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { createChoreAction } from '../actions';

/**
 * The "Create a mission" form, with its outcome shown.
 *
 * It used to be `<form action={createChoreAction}>` over an action returning
 * nothing: the form cleared itself whether or not the chore was created. A
 * non-manager's submission — which always carries the default 10 points, and
 * so is always refused as pricing a chore — looked exactly like a success.
 *
 * `onSubmit` rather than `action`, so a refused submission keeps what the
 * parent typed; the form is reset only once the chore exists. Audit C1-S9-73.
 */
export function CreateChoreForm({ className, children }: { className?: string; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // One chore per click: a second submit while the first is in flight would
    // create it twice.
    if (pending) return;
    const form = event.currentTarget;
    const fd = new FormData(form);
    setError(null);
    start(async () => {
      const res = await createChoreAction(fd);
      if (!res.ok) { setError(res.error); return; }
      form.reset();
    });
  };

  return (
    <form onSubmit={submit} aria-busy={pending} className={className}>
      {children}
      {error && <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}
    </form>
  );
}
