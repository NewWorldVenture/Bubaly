'use client';

// Per-alert controls: "Mark seen" (clears the NEW badge) + delete. Wired to the
// saved-search server actions.
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { deleteSavedSearchAction, markSearchSeenAction } from '@/app/(app)/marketplace/alerts/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function AlertActions({ id, newCount }: { id: string; newCount: number }) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => { const res = await fn(); if (!res.ok) toastError(res.error); else router.refresh(); });

  return (
    <div className="flex items-center gap-1">
      {newCount > 0 && (
        <button
          type="button" disabled={pending} onClick={() => run(() => markSearchSeenAction(id))}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted transition hover:text-fg"
        >
          <Check className="h-3.5 w-3.5" /> {t('alertActions.markSeen')}
        </button>
      )}
      <button
        type="button" disabled={pending} onClick={() => run(() => deleteSavedSearchAction(id))}
        aria-label={t('alertActions.deleteAlert')}
        className="rounded-lg border border-border p-1.5 text-muted transition hover:text-rose-500"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
