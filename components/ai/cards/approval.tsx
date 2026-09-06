'use client';

// The approval card kind wraps the shared approval card (§31) so a decision
// asked for in chat is the same component, with the same three buttons and
// the same edit modal, as the one on Home and in the inbox. After a decision
// the card shows the outcome in place instead of vanishing, because a card
// that disappears leaves the family wondering what happened.
import { useState } from 'react';
import Link from 'next/link';
import { Check, ShieldCheck, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ApprovalCard, type ApprovalCardResult } from '@/components/approvals/approval-card';
import { runHref, type ApprovalResultCard } from '@/lib/ai/result-cards';
import { useTranslations } from '@/components/i18n/locale-provider';

export function ApprovalResultCardView({ card, compact = false, canDecide, className }: { card: ApprovalResultCard; compact?: boolean; canDecide: boolean; className?: string }) {
  const t = useTranslations();
  const [result, setResult] = useState<ApprovalCardResult | null>(null);

  if (result && result.decision !== 'pending') {
    const approved = result.decision !== 'rejected';
    return (
      <div className={cn('flex items-start gap-3 rounded-2xl border border-border bg-surface/60 p-3 text-sm', className)}>
        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-xl', approved ? 'bg-success/15 text-success' : 'bg-elevated text-muted')}>
          {approved ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{card.title}</p>
          <p className="text-xs text-muted">{result.summary}</p>
          {result.resumedRunId && (
            <Link href={runHref(result.resumedRunId)} className="focus-ring coarse:min-h-11 mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t('approval.followAlong')}
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <ApprovalCard
      approval={card.approval}
      canDecide={canDecide}
      compact={compact}
      onResult={setResult}
      className={className}
    />
  );
}
