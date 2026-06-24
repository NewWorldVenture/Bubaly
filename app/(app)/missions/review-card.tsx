'use client';

import { useState, useTransition } from 'react';
import { Check, X, RotateCcw, AlertTriangle, Bot, Loader2, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { REWARD_MODE_LABELS, fmtCash, type RewardMode } from '@/lib/chores/logic';
import { approveSubmissionAction, rejectSubmissionAction } from './actions';

export type ReviewItem = {
  submissionId: string;
  choreTitle: string;
  instructions: string | null;
  memberName: string;
  memberColor: string | null;
  note: string | null;
  status: string;
  mediaUrls: string[];
  aiScore: number | null;
  aiStatus: string | null;
  aiKidFeedback: string | null;
  aiParentSummary: string | null;
  aiIsFallback: boolean;
  safetyFlags: string[];
  recommendedType: string | null;
  recommendedAmount: number | null;
  rewardMode: string;
  defaultPoints: number;
  isDisputed: boolean;
  disputeReason: string | null;
};

const inputCls = 'h-9 w-24 rounded-lg border border-border bg-surface/60 px-2 text-sm focus-ring';

function scoreTone(score: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (score == null) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

export function ReviewCard({ item }: { item: ReviewItem }) {
  const [pending, start] = useTransition();
  const [override, setOverride] = useState(false);
  const isCash = item.rewardMode === 'fixed_cash' || item.rewardMode === 'ai_cash';

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Avatar name={item.memberName} color={item.memberColor} size={36} />
          <div>
            <p className="font-semibold">{item.choreTitle}</p>
            <p className="text-xs text-muted">{item.memberName}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {item.isDisputed && <Badge tone="warning"><MessageCircle className="h-3 w-3" /> Disputed</Badge>}
          {item.safetyFlags.length > 0 && <Badge tone="danger"><AlertTriangle className="h-3 w-3" /> Safety</Badge>}
          <Badge tone="neutral">{REWARD_MODE_LABELS[item.rewardMode as RewardMode] ?? item.rewardMode}</Badge>
        </div>
      </div>

      {item.instructions && <p className="mt-2 text-sm text-muted">{item.instructions}</p>}

      {item.mediaUrls.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.mediaUrls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="Proof" className="h-28 w-28 rounded-xl border border-border object-cover" />
            </a>
          ))}
        </div>
      )}

      {item.note && <p className="mt-2 rounded-lg bg-elevated/50 p-2 text-sm"><span className="font-medium">Kid note:</span> {item.note}</p>}
      {item.isDisputed && item.disputeReason && <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-sm">“{item.disputeReason}”</p>}

      {/* AI verdict */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-elevated/40 p-2 text-sm">
        <Bot className="h-4 w-4 text-brand" />
        {item.aiIsFallback ? (
          <span className="text-muted">AI review unavailable — please check manually.</span>
        ) : (
          <>
            <Badge tone={scoreTone(item.aiScore)}>Score {item.aiScore ?? '—'}</Badge>
            <span className="text-muted">{item.aiKidFeedback ?? item.aiParentSummary ?? 'Reviewed.'}</span>
            {item.recommendedType && item.recommendedType !== 'none' && (
              <span className="ml-auto text-xs text-muted">Suggests: {item.recommendedType === 'cash' ? fmtCash(Math.round((item.recommendedAmount ?? 0) * 100)) : `${item.recommendedAmount ?? 0} pts`}</span>
            )}
          </>
        )}
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <form action={(fd) => start(async () => { await approveSubmissionAction(fd); })}>
          <input type="hidden" name="submission_id" value={item.submissionId} />
          {item.aiScore != null && <input type="hidden" name="score" value={item.aiScore} />}
          {override && (
            <input type="number" name={isCash ? 'cash_cents' : 'points'} placeholder={isCash ? 'cents' : 'points'} className={inputCls + ' mr-2'} />
          )}
          <button disabled={pending} className="inline-flex h-9 items-center gap-1 rounded-lg bg-success px-3 text-sm font-medium text-white disabled:opacity-60">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
          </button>
        </form>
        <button onClick={() => setOverride((o) => !o)} className="text-xs text-muted hover:text-fg">{override ? 'Use AI amount' : 'Adjust amount'}</button>

        <form action={(fd) => start(async () => { await rejectSubmissionAction(fd); })} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="submission_id" value={item.submissionId} />
          <button name="redo" value="1" disabled={pending} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:text-fg">
            <RotateCcw className="h-4 w-4" /> Ask to redo
          </button>
          <button name="redo" value="0" disabled={pending} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:text-danger">
            <X className="h-4 w-4" /> Reject
          </button>
        </form>
      </div>
    </div>
  );
}
