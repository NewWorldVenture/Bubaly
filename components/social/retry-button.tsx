'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { retryPublishAction } from '@/app/(app)/dashboard/social/actions';

export function RetryPublishButton({ postId }: { postId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await retryPublishAction(postId);
          setMsg(r.ok ? 'Retried — see results below.' : (r.error ?? 'Retry failed'));
        })}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Retry publish
      </button>
      {msg && <span className="text-xs text-muted">{msg}</span>}
    </div>
  );
}
