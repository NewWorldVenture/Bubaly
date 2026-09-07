'use client';

// One-tap decisions for the M5 "Needs you" sources, rendered inline on the
// card the way HomeApprovalActions is for money approvals: a memory Bubaly
// inferred gets Confirm / Dismiss, a message waiting for an answer gets Reply
// (a link to the message in the Contact Center) and Archive.
//
// Nothing here claims an outcome before the server has persisted it: the
// "done" label and the toast appear only after the action returned ok, and the
// router refresh re-reads the list from the tables.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, Check, Loader2, Reply, X } from 'lucide-react';
import {
  archiveInboxMessageAction, confirmFactSuggestionAction, dismissFactSuggestionAction,
  type NeedsYouActionResult,
} from '@/app/(app)/dashboard/needs-you/actions';
import { useToast } from '@/components/ui/toast';
import { useTranslations } from '@/components/i18n/locale-provider';

function useDecision(fallbackKey: string) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(name: string, doneKey: string, act: () => Promise<NeedsYouActionResult>) {
    if (busy || done) return;
    setBusy(name);
    try {
      const res = await act();
      if (!res.ok) { toastError(res.error || t(fallbackKey)); return; }
      setDone(doneKey);
      success(t(doneKey));
      router.refresh();
    } catch {
      toastError(t(fallbackKey));
    } finally {
      setBusy(null);
    }
  }

  return { t, busy, done, run };
}

export function FactSuggestionActions({ id }: { id: string }) {
  const { t, busy, done, run } = useDecision('needsYouActions.couldNotUpdateThatMemory');
  if (done) return <span className="shrink-0 text-xs font-semibold text-muted">{t(done)}</span>;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button" disabled={busy !== null}
        onClick={() => run('confirm', 'needsYouActions.savedToFamilyMemory', () => confirmFactSuggestionAction(id))}
        className="inline-flex h-8 items-center gap-1 rounded-lg bg-success/15 px-2.5 text-xs font-semibold text-success transition hover:bg-success/25 disabled:opacity-50"
      >
        {busy === 'confirm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
        {t('needsYouActions.confirm')}
      </button>
      <button
        type="button" disabled={busy !== null}
        onClick={() => run('dismiss', 'needsYouActions.dismissed', () => dismissFactSuggestionAction(id))}
        className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/5 px-2.5 text-xs font-semibold text-muted transition hover:bg-white/10 disabled:opacity-50"
      >
        {busy === 'dismiss' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
        {t('needsYouActions.dismiss')}
      </button>
    </div>
  );
}

export function InboxMessageActions({ id, href }: { id: string; href: string }) {
  const { t, busy, done, run } = useDecision('needsYouActions.couldNotUpdateThatMessage');
  if (done) return <span className="shrink-0 text-xs font-semibold text-muted">{t(done)}</span>;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Link
        href={href}
        className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand/15 px-2.5 text-xs font-semibold text-brand-text transition hover:bg-brand/25 focus-ring"
      >
        <Reply className="h-3.5 w-3.5" aria-hidden /> {t('needsYouActions.reply')}
      </Link>
      <button
        type="button" disabled={busy !== null}
        onClick={() => run('archive', 'needsYouActions.archived', () => archiveInboxMessageAction(id))}
        className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/5 px-2.5 text-xs font-semibold text-muted transition hover:bg-white/10 disabled:opacity-50"
      >
        {busy === 'archive' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Archive className="h-3.5 w-3.5" aria-hidden />}
        {t('needsYouActions.archive')}
      </button>
    </div>
  );
}
