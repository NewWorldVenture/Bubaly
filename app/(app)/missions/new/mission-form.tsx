'use client';

// The <form> around the new-mission fields, so the failure has somewhere to go.
//
// The page is a server component and used `<form action={createChoreAction}>`
// directly. That action returned `Promise<void>` with three bare `return;`
// exits — not a manager, no title, the insert failing — and `revalidatePath`
// on the success path only, so a parent who filled the form in and pressed
// Create watched nothing happen at all. The worst of the three was the
// assignment insert: the chore row was created, the assignment failed, the
// chore was deleted again to clean up, and the screen said nothing.
//
// Only the <form> element moves here; every field stays server-rendered and
// arrives as `children`. That keeps 47 lines of markup, and the server-side
// `t()` calls around them, exactly where they were.

import { useState } from 'react';
import { createChoreAction } from '../actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function MissionForm({ className, children }: { className?: string; children: React.ReactNode }) {
  const t = useTranslations();
  const [error, setError] = useState<string | null>(null);
  // In flight, the fields and the page's SubmitButton are disabled together, so
  // a second press cannot create the mission twice. The SubmitButton the page
  // passes in already reads useFormStatus; this holds for anything else in
  // `children` too, and it is visible to the form-in-flight guard, which reads
  // one file at a time and cannot see a button that arrives as a child.
  const [pending, setPending] = useState(false);

  return (
    <>
      <form
        className={className}
        action={async (formData) => {
          if (pending) return;
          setPending(true);
          setError(null);
          try {
            const result = await createChoreAction(formData);
            if (!result.ok) setError(result.error ?? t('submitForm.somethingWentWrongTryAgain'));
          } finally {
            setPending(false);
          }
        }}
      >
        {/* `contents` keeps the fields as direct grid items of the form. */}
        <fieldset disabled={pending} className="contents">{children}</fieldset>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </>
  );
}
