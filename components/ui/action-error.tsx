'use client';

// Reporting for server actions that fail by THROWING.
//
// A lot of this app's actions are declared `Promise<void>` and signal failure
// with a translated Error — `saveRow(..., 'Could not save that policy.')`,
// `requireUserContext()`, `requireSocialPermission()`. Their callers await them
// bare inside a transition:
//
//   start(async () => { await deletePolicyAction(p.id); })
//   <form action={(fd) => start(async () => { await savePolicyAction(fd); setOpen(false); })}>
//
// so a refusal threw past everything after it — the modal never closed, the
// spinner never cleared — and said nothing at all. The reason existed and was
// already in the reader's language.
//
// `run` catches, keeps the thrown message, and reports whether the action got
// through so the caller can decide what to close. `<ActionError>` renders it
// next to the thing that failed. Deliberately NOT a toast: these components
// are rendered on their own in tests and have no <ToastProvider> above them, so
// a toast would turn a failed save into a crash.
import { useCallback, useState } from 'react';

import { useTranslations } from '@/components/i18n/locale-provider';

export function useActionError() {
  const t = useTranslations();
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setMessage(null);
    try {
      await action();
      return true;
    } catch (err) {
      // The action's own message is already translated and specific; the
      // generic is only for a throw that carries nothing.
      setMessage(err instanceof Error && err.message ? err.message : t('globalError.somethingWentWrong'));
      return false;
    }
  }, [t]);

  return { message, run, clear: useCallback(() => setMessage(null), []) };
}

export function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2 text-xs text-danger">
      {message}
    </p>
  );
}
