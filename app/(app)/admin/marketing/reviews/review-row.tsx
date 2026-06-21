'use client';

import { useState, useTransition } from 'react';
import { Star, Check, Sparkles, X, Reply, Trash2, Loader2 } from 'lucide-react';
import { moderateReviewAction, replyToReviewAction, deleteReviewAction } from './actions';
import { SOURCE_LABELS, STATUS_TONE, STATUS_LABELS, type ReviewSource, type ReviewStatus } from '@/lib/marketing/reviews';
import { Badge } from '@/components/ui/badge';

type Review = {
  id: string; rating: number; title: string | null; body: string | null;
  author_name: string | null; author_email: string | null; source: string; status: string;
  reply: string | null; submitted_at: string;
};

export function ReviewRow({ review }: { review: Review }) {
  const [pending, start] = useTransition();
  const [replyOpen, setReplyOpen] = useState(false);
  const moderate = (status: ReviewStatus) => start(async () => { await moderateReviewAction(review.id, status); });

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-amber-400" aria-label={`${review.rating} stars`}>
            {[1, 2, 3, 4, 5].map((v) => <Star key={v} className={`h-4 w-4 ${v <= review.rating ? 'fill-amber-400' : 'text-border'}`} />)}
          </div>
          {review.title && <p className="mt-1 font-semibold">{review.title}</p>}
          {review.body && <p className="mt-0.5 text-sm text-muted">{review.body}</p>}
          <p className="mt-1 text-xs text-muted">{review.author_name || 'Anonymous'}{review.author_email ? ` · ${review.author_email}` : ''} · {new Date(review.submitted_at).toLocaleDateString()}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={STATUS_TONE[review.status as ReviewStatus] ?? 'neutral'}>{STATUS_LABELS[review.status as ReviewStatus] ?? review.status}</Badge>
          <span className="text-[11px] text-muted">{SOURCE_LABELS[review.source as ReviewSource] ?? review.source}</span>
        </div>
      </div>

      {review.reply && (
        <div className="mt-2 rounded-lg border border-border bg-elevated/50 p-2 text-xs">
          <p className="font-medium text-brand">Your reply</p>
          <p className="mt-0.5 text-muted">{review.reply}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2 text-xs">
        {review.status !== 'approved' && <button onClick={() => moderate('approved')} disabled={pending} className="inline-flex items-center gap-1 text-success hover:underline"><Check className="h-3.5 w-3.5" /> Approve</button>}
        {review.status !== 'featured' && <button onClick={() => moderate('featured')} disabled={pending} className="inline-flex items-center gap-1 text-brand hover:underline"><Sparkles className="h-3.5 w-3.5" /> Feature</button>}
        {review.status !== 'rejected' && <button onClick={() => moderate('rejected')} disabled={pending} className="inline-flex items-center gap-1 text-muted hover:text-danger"><X className="h-3.5 w-3.5" /> Reject</button>}
        <button onClick={() => setReplyOpen((o) => !o)} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Reply className="h-3.5 w-3.5" /> Reply</button>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
        <button onClick={() => start(async () => { await deleteReviewAction(review.id); })} className="ml-auto inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>

      {replyOpen && (
        <form action={(fd) => start(async () => { await replyToReviewAction(fd); setReplyOpen(false); })} className="mt-2 space-y-2">
          <input type="hidden" name="id" value={review.id} />
          <textarea name="reply" defaultValue={review.reply ?? ''} rows={2} placeholder="Write a public reply…" className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <button className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-xs font-medium text-brand-fg">Save reply</button>
        </form>
      )}
    </div>
  );
}
