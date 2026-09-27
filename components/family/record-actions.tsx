'use client';
// Small client buttons that drive the server actions: delete a record, resolve
// an AI recommendation, or approve/skip an autonomous automation run.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Check, X, Loader2 } from 'lucide-react';
import {
  deleteFamilyRecord,
  setRecommendationStatus,
  resolveAutomationRun,
} from '@/lib/family/actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export function DeleteButton({ table, id, label = 'Delete' }: { table: string; id: string; label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      aria-label={label}
      disabled={pending}
      onClick={() => start(async () => { await deleteFamilyRecord(table, id); router.refresh(); })}
      className="text-muted transition hover:text-danger disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}

export function RecommendationActions({ id }: { id: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (status: 'accepted' | 'dismissed') =>
    start(async () => { await setRecommendationStatus(id, status); router.refresh(); });
  return (
    <div className="flex items-center gap-2">
      <button
        type="button" disabled={pending} onClick={() => act('accepted')}
        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
      >
        <Check className="h-3.5 w-3.5" /> {t('recordActions.accept')}
      </button>
      <button
        type="button" disabled={pending} onClick={() => act('dismissed')}
        className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-semibold text-muted hover:bg-white/10 disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" /> {t('recordActions.dismiss')}
      </button>
    </div>
  );
}

export function AutomationApproval({ id }: { id: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  // The action can refuse (the run waits on an approval card, the approval was
  // already decided, a read failed) or record one vote of several. Either way
  // the line stays put after the refresh, so the sentence is the only thing
  // that tells the parent why — dropping it made a refusal look like a no-op.
  const [message, setMessage] = useState<{ tone: 'error' | 'note'; text: string } | null>(null);
  const act = (decision: 'approved' | 'skipped') =>
    start(async () => {
      setMessage(null);
      const res = await resolveAutomationRun(id, decision);
      if (!res.ok) setMessage({ tone: 'error', text: res.error });
      else if (res.note) setMessage({ tone: 'note', text: res.note });
      router.refresh();
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button" disabled={pending} onClick={() => act('approved')}
          className={cn('inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50')}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t('recordActions.approve')}
        </button>
        <button
          type="button" disabled={pending} onClick={() => act('skipped')}
          className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-muted hover:bg-white/10 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" /> {t('recordActions.skip')}
        </button>
      </div>
      {message && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={cn('max-w-xs text-right text-xs', message.tone === 'error' ? 'text-danger' : 'text-muted')}>
          {message.text}
        </p>
      )}
    </div>
  );
}
