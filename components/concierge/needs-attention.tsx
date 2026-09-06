'use client';

// §16 "Needs Your Attention": one ranked list of everything waiting on a
// person, with the decision made right here where it can be — an AI approval
// is the shared ApprovalCard (Approve / Edit / Decline resumes the run), a
// money approval gets the wallet's one-tap buttons, a recommendation gets
// Accept / Dismiss, and a run waiting on an answer links to its question.
//
// The list itself is built and ranked on the server (lib/home/needs-build.ts
// + needs-attention.ts); this component only renders it and hosts the buttons.
// Kids and guests see the same list read-only — every action re-checks the
// role on the server.
import Link from 'next/link';
import {
  AlarmClock, Bell, CalendarClock, CheckSquare, ChevronRight, FileClock, Lightbulb, MessageCircleQuestion,
  Pill, RefreshCw, ShieldCheck, ShoppingCart, Sparkles,
} from 'lucide-react';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { HomeApprovalActions } from '@/components/dashboard/home-approval-actions';
import { RecommendationActions } from '@/components/family/record-actions';
import type { ApprovalCardData } from '@/lib/approvals/card-data';
import type { NeedItem } from '@/lib/home/needs-attention';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type NeedRenderMeta = { icon: React.ComponentType<{ className?: string }>; iconBg: string; cta: string; subtitle: string };

const NEED_META: Record<string, NeedRenderMeta> = {
  approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'A family member is waiting on your approval.' },
  run_awaiting_approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'Bubaly is ready and waiting for the go-ahead.' },
  run_awaiting_answer: { icon: MessageCircleQuestion, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Answer', subtitle: 'One quick answer and Bubaly can finish this.' },
  recommendation: { icon: Lightbulb, iconBg: 'bg-brand/15 text-brand-text', cta: 'View', subtitle: 'Bubaly suggests this; accept it and it gets done.' },
  calendar_conflict: { icon: CalendarClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Resolve', subtitle: 'Two events are double-booked.' },
  renewal: { icon: RefreshCw, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'Renew', subtitle: 'Renew it before it lapses.' },
  document: { icon: FileClock, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'View', subtitle: 'A document is expiring soon.' },
  chore_signoff: { icon: CheckSquare, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'Chores are waiting for your sign-off.' },
  reminder_overdue: { icon: AlarmClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Catch up', subtitle: 'These were due earlier.' },
  meds: { icon: Pill, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'View', subtitle: 'Check the medication schedule.' },
  reminder_today: { icon: Bell, iconBg: 'bg-sky-500/15 text-sky-400', cta: 'View', subtitle: 'Coming up today.' },
  chores_todo: { icon: CheckSquare, iconBg: 'bg-violet-500/15 text-violet-400', cta: 'View', subtitle: 'Keep the momentum going.' },
  grocery: { icon: ShoppingCart, iconBg: 'bg-emerald-500/15 text-emerald-400', cta: 'Update', subtitle: 'Items may be running low.' },
  todos: { icon: CheckSquare, iconBg: 'bg-teal-500/15 text-teal-400', cta: 'View', subtitle: 'Personal items waiting for you.' },
};
const DEFAULT_NEED_META: NeedRenderMeta = { icon: Bell, iconBg: 'bg-brand/15 text-brand-text', cta: 'View', subtitle: '' };

export type NeedsAttentionProps = {
  /** Already ranked and capped by `topNeeds`. */
  items: NeedItem[];
  more: number;
  headline: string;
  /** Card data for `ai_approval` items, keyed by approval id. */
  approvals: Record<string, ApprovalCardData>;
  /** `parent_approvals.kind` for `approval` items, keyed by approval id — decides which wallet action runs. */
  moneyApprovalKinds: Record<string, string>;
  /** Body text for `recommendation` items, keyed by recommendation id. */
  recommendationBodies: Record<string, string | null>;
  canDecide: boolean;
  className?: string;
};

const ID_PREFIX = /^[a-z_]+:/;

export function NeedsAttention({ items, more, headline, approvals, moneyApprovalKinds, recommendationBodies, canDecide, className }: NeedsAttentionProps) {
  const t = useTranslations();
  return (
    <section aria-labelledby="needs-you-heading" className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-text" aria-hidden />
        <h2 id="needs-you-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">{t('needsAttention.needsYourAttention')}</h2>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
          {t('needsAttention.nothingNeedsYouRightNowBubaly')}
        </p>
      ) : (
        <>
          <p className="-mt-1 text-sm text-fg/80">{headline}</p>
          <ul className="space-y-2.5">
            {items.map((item) => {
              const rawId = item.id.replace(ID_PREFIX, '');
              const meta = NEED_META[item.kind] ?? DEFAULT_NEED_META;
              const Icon = meta.icon;
              const urgent = item.urgency === 'urgent' || item.urgency === 'emergency';

              if (item.kind === 'ai_approval') {
                const card = approvals[rawId];
                if (card) {
                  return <li key={item.id}><ApprovalCard approval={card} canDecide={canDecide} compact /></li>;
                }
              }

              const cardClass = cn(
                'flex items-center gap-4 rounded-2xl border p-4 transition',
                urgent ? 'border-amber-500/20 bg-amber-500/5' : 'border-border bg-surface/40',
              );
              const subtitle = item.kind === 'recommendation' ? (recommendationBodies[rawId]?.split('\n')[0] || meta.subtitle) : meta.subtitle;
              const body = (
                <>
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', meta.iconBg)}>
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">{item.title}</p>
                    {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
                  </div>
                </>
              );

              // Buttons cannot nest inside a link, so rows with one-tap actions
              // are a div whose title links out.
              const moneyKind = item.kind === 'approval' ? moneyApprovalKinds[rawId] : undefined;
              if (moneyKind !== undefined && canDecide) {
                return (
                  <li key={item.id} className={cardClass}>
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-4 hover:opacity-90 focus-ring">{body}</Link>
                    <HomeApprovalActions approvalId={rawId} kind={moneyKind} />
                  </li>
                );
              }
              if (item.kind === 'recommendation' && canDecide) {
                return (
                  <li key={item.id} className={cn(cardClass, 'flex-col items-stretch gap-3 sm:flex-row sm:items-center')}>
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-4 hover:opacity-90 focus-ring">{body}</Link>
                    <div className="flex justify-end"><RecommendationActions id={rawId} /></div>
                  </li>
                );
              }
              return (
                <li key={item.id}>
                  <Link href={item.href} className={cn(cardClass, 'min-h-[44px] hover:bg-elevated focus-ring')}>
                    {body}
                    <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-text">
                      {meta.cta} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {more > 0 && <p className="text-xs text-muted">+{more} more {more === 1 ? 'item needs' : 'items need'} you.</p>}
        </>
      )}
    </section>
  );
}
