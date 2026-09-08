'use client';

// §16 "Needs Your Attention": one ranked list of everything waiting on a
// person, with the decision made right here where it can be — an AI approval
// is the shared ApprovalCard (Approve / Edit / Decline resumes the run), a
// money approval gets the wallet's one-tap buttons, a recommendation gets
// Accept / Dismiss, a memory Bubaly inferred gets Confirm / Dismiss, a message
// waiting for an answer gets Reply / Archive, and a run waiting on an answer
// links to its question.
//
// The list itself is built and ranked on the server (lib/home/needs-build.ts
// + needs-attention.ts); this component only renders it and hosts the buttons.
// Home shows the top five with a link to /dashboard/needs-you, which renders
// the same component uncapped. Kids and guests see the same list read-only —
// every action re-checks the role on the server.
import Link from 'next/link';
import {
  AlarmClock, Bell, Brain, CalendarClock, CheckSquare, ChevronRight, FileClock, FileSignature, Lightbulb,
  MessageCircleQuestion, MessageSquareReply, PartyPopper, Pill, Receipt, RefreshCw, ShieldCheck, ShoppingCart, Sparkles,
} from 'lucide-react';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { HomeApprovalActions } from '@/components/dashboard/home-approval-actions';
import { RecommendationActions } from '@/components/family/record-actions';
import { FactSuggestionActions, InboxMessageActions } from '@/components/concierge/needs-you-actions';
import type { ApprovalCardData } from '@/lib/approvals/card-data';
import type { NeedItem } from '@/lib/home/needs-attention';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type NeedRenderMeta = {
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  /** English CTA (documentation) + the catalogue key the card renders through `t()`. */
  cta: string;
  ctaKey: string;
  /** English subtitle (documentation) + its catalogue key; empty when the card has none. */
  subtitle: string;
  subtitleKey: string;
};

const NEED_META: Record<string, NeedRenderMeta> = {
  approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', ctaKey: 'needsAttention.ctaReview', subtitle: 'A family member is waiting on your approval.', subtitleKey: 'needsAttention.subtitleApproval' },
  run_awaiting_approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', ctaKey: 'needsAttention.ctaReview', subtitle: 'Bubaly is ready and waiting for the go-ahead.', subtitleKey: 'needsAttention.subtitleRunAwaitingApproval' },
  run_awaiting_answer: { icon: MessageCircleQuestion, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Answer', ctaKey: 'needsAttention.ctaAnswer', subtitle: 'One quick answer and Bubaly can finish this.', subtitleKey: 'needsAttention.subtitleRunAwaitingAnswer' },
  recommendation: { icon: Lightbulb, iconBg: 'bg-brand/15 text-brand-text', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'Bubaly suggests this; accept it and it gets done.', subtitleKey: 'needsAttention.subtitleRecommendation' },
  fact_suggestion: { icon: Brain, iconBg: 'bg-brand/15 text-brand-text', cta: 'Confirm', ctaKey: 'needsAttention.ctaConfirm', subtitle: 'Bubaly noticed this. Confirm it and it becomes family memory.', subtitleKey: 'needsAttention.subtitleFactSuggestion' },
  inbox_message: { icon: MessageSquareReply, iconBg: 'bg-sky-500/15 text-sky-400', cta: 'Reply', ctaKey: 'needsAttention.ctaReply', subtitle: 'Someone wrote to the family and is waiting to hear back.', subtitleKey: 'needsAttention.subtitleInboxMessage' },
  paperwork_sign: { icon: FileSignature, iconBg: 'bg-violet-500/15 text-violet-400', cta: 'Sign', ctaKey: 'needsAttention.ctaSign', subtitle: 'A form needs your signature.', subtitleKey: 'needsAttention.subtitlePaperworkSign' },
  paperwork_pay: { icon: Receipt, iconBg: 'bg-emerald-500/15 text-emerald-400', cta: 'Pay', ctaKey: 'needsAttention.ctaPay', subtitle: 'A payment is due on this paperwork.', subtitleKey: 'needsAttention.subtitlePaperworkPay' },
  paperwork_rsvp: { icon: PartyPopper, iconBg: 'bg-pink-500/15 text-pink-400', cta: 'RSVP', ctaKey: 'needsAttention.ctaRsvp', subtitle: 'An RSVP is waiting on you.', subtitleKey: 'needsAttention.subtitlePaperworkRsvp' },
  calendar_conflict: { icon: CalendarClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Resolve', ctaKey: 'needsAttention.ctaResolve', subtitle: 'Two events are double-booked.', subtitleKey: 'needsAttention.subtitleCalendarConflict' },
  renewal: { icon: RefreshCw, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'Renew', ctaKey: 'needsAttention.ctaRenew', subtitle: 'Renew it before it lapses.', subtitleKey: 'needsAttention.subtitleRenewal' },
  document: { icon: FileClock, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'A document is expiring soon.', subtitleKey: 'needsAttention.subtitleDocument' },
  chore_signoff: { icon: CheckSquare, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', ctaKey: 'needsAttention.ctaReview', subtitle: 'Chores are waiting for your sign-off.', subtitleKey: 'needsAttention.subtitleChoreSignoff' },
  reminder_overdue: { icon: AlarmClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Catch up', ctaKey: 'needsAttention.ctaCatchUp', subtitle: 'These were due earlier.', subtitleKey: 'needsAttention.subtitleReminderOverdue' },
  meds: { icon: Pill, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'Check the medication schedule.', subtitleKey: 'needsAttention.subtitleMeds' },
  reminder_today: { icon: Bell, iconBg: 'bg-sky-500/15 text-sky-400', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'Coming up today.', subtitleKey: 'needsAttention.subtitleReminderToday' },
  chores_todo: { icon: CheckSquare, iconBg: 'bg-violet-500/15 text-violet-400', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'Keep the momentum going.', subtitleKey: 'needsAttention.subtitleChoresTodo' },
  grocery: { icon: ShoppingCart, iconBg: 'bg-emerald-500/15 text-emerald-400', cta: 'Update', ctaKey: 'needsAttention.ctaUpdate', subtitle: 'Items may be running low.', subtitleKey: 'needsAttention.subtitleGrocery' },
  todos: { icon: CheckSquare, iconBg: 'bg-teal-500/15 text-teal-400', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: 'Personal items waiting for you.', subtitleKey: 'needsAttention.subtitleTodos' },
};
const DEFAULT_NEED_META: NeedRenderMeta = { icon: Bell, iconBg: 'bg-brand/15 text-brand-text', cta: 'View', ctaKey: 'needsAttention.ctaView', subtitle: '', subtitleKey: '' };

export type NeedsAttentionProps = {
  /** Already ranked — capped by `topNeeds` on Home, the whole list on /dashboard/needs-you. */
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
  /** Where the full, uncapped list lives; renders a "See all" link in the header and on the "+N more" line. */
  seeAllHref?: string;
  className?: string;
};

const ID_PREFIX = /^[a-z_]+:/;

export function NeedsAttention({ items, more, headline, approvals, moneyApprovalKinds, recommendationBodies, canDecide, seeAllHref, className }: NeedsAttentionProps) {
  const t = useTranslations();
  const moreLine = more > 0
    ? (more === 1 ? t('needsAttention.moreItemNeedsYou', { n: more }) : t('needsAttention.moreItemsNeedYou', { n: more }))
    : '';
  return (
    <section aria-labelledby="needs-you-heading" className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-text" aria-hidden />
        <h2 id="needs-you-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">{t('needsAttention.needsYourAttention')}</h2>
        {seeAllHref && (
          <Link href={seeAllHref} className="ml-auto flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline focus-ring">
            {t('needsAttention.seeAll')} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
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
              const metaSubtitle = meta.subtitleKey ? t(meta.subtitleKey) : '';
              const subtitle = item.kind === 'recommendation' ? (recommendationBodies[rawId]?.split('\n')[0] || metaSubtitle) : metaSubtitle;
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
              if (item.kind === 'fact_suggestion' && canDecide) {
                return (
                  <li key={item.id} className={cn(cardClass, 'flex-col items-stretch gap-3 sm:flex-row sm:items-center')}>
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-4 hover:opacity-90 focus-ring">{body}</Link>
                    <div className="flex justify-end"><FactSuggestionActions id={rawId} /></div>
                  </li>
                );
              }
              if (item.kind === 'inbox_message' && canDecide) {
                return (
                  <li key={item.id} className={cn(cardClass, 'flex-col items-stretch gap-3 sm:flex-row sm:items-center')}>
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-4 hover:opacity-90 focus-ring">{body}</Link>
                    <div className="flex justify-end"><InboxMessageActions id={rawId} href={item.href} /></div>
                  </li>
                );
              }
              return (
                <li key={item.id}>
                  <Link href={item.href} className={cn(cardClass, 'min-h-[44px] hover:bg-elevated focus-ring')}>
                    {body}
                    <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-text">
                      {t(meta.ctaKey)} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {more > 0 && (
            seeAllHref ? (
              <Link href={seeAllHref} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline focus-ring">
                {moreLine} {t('needsAttention.seeAll')} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : (
              <p className="text-xs text-muted">{moreLine}</p>
            )
          )}
        </>
      )}
    </section>
  );
}
