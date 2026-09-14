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

  return (
    <>
      <form
        className={className}
        action={async (formData) => {
          setError(null);
          const result = await createChoreAction(formData);
          if (!result.ok) setError(result.error ?? t('submitForm.somethingWentWrongTryAgain'));
        }}
      >
        {children}
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </>
  );
}
