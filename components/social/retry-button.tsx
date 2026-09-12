'use client';

import { useRef, useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { retryPublishAction } from '@/app/(app)/dashboard/social/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function RetryPublishButton({ postId }: { postId: string }) {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const inFlight = useRef(false);
  const [msg, setMsg] = useState('');
  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setMsg('');
    let review = false;
    try {
      const r = await retryPublishAction(postId);
      review = r.outcome?.status === 'publishing' || r.outcome?.status === 'published';
      setMsg(r.ok ? t(r.outcome?.status === 'publishing' ? 'socialPost.awaitingConfirmation' : 'socialPost.retryAttempted')
        : (r.error ?? t('socialStudio.requestUnconfirmed')));
    } catch {
      review = true;
      setMsg(t('socialStudio.requestUnconfirmed'));
    } finally {
      inFlight.current = review;
      setReviewNeeded(review);
      setPending(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending || reviewNeeded}
        onClick={retry}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t('retryButton.retryPublish')}
      </button>
      {msg && <span className="text-xs text-muted">{msg}</span>}
    </div>
  );
}
