'use client';

// The one household queue: everything that arrived, ranked by what needs a
// person first, above the Communications Hub log it used to be the only view of.
//
// The rows come from the server page, which reads three tables and says which
// of them answered. This component never queries: it renders what it was given,
// says plainly when a source could not be read, and offers exactly one action —
// "Handle it" — which files the message through the normal intake.
//
// HONESTY: a row shows "Handled" only when `item.handled` is true, and that
// comes from `family_inbox_messages.ai_handled`, written after a request was
// persisted. The run link that appears after handling is live for this response
// only, because the row has no column to remember it in; the copy says so
// rather than implying a durable link.
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowRight, Check, FileText, Inbox as InboxIcon, Loader2,
  Mail, MessageSquare, Phone, Sparkles,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { handleInboxMessageAction } from '@/app/(app)/dashboard/inbox/actions';
import type { InboxReason, InboxSource, UnifiedInboxItem } from '@/lib/inbox/unify';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

/** Which of the three reads failed, so the queue can say so instead of implying "nothing arrived". */
export type InboxQueueUnavailable = {
  messages: boolean;
  paperwork: boolean;
  communications: boolean;
};

const REASON_STYLE: Record<InboxReason, { labelKey: string; className: string }> = {
  urgent: { labelKey: 'inboxQueue.urgent', className: 'bg-red-500/15 text-red-400' },
  soon:   { labelKey: 'inboxQueue.soon',   className: 'bg-amber-500/15 text-amber-400' },
  unread: { labelKey: 'inboxQueue.unread', className: 'bg-blue-500/15 text-blue-400' },
  recent: { labelKey: 'inboxQueue.recent', className: 'bg-surface text-muted' },
};

const SOURCE_META: Record<InboxSource, { labelKey: string; icon: React.ComponentType<{ className?: string }> }> = {
  contact_center: { labelKey: 'inboxQueue.frontDesk',     icon: Phone },
  paperwork:      { labelKey: 'inboxQueue.paperwork',     icon: FileText },
  communications: { labelKey: 'inboxQueue.familyLog',     icon: MessageSquare },
};

const CHANNEL_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  email: Mail, sms: MessageSquare, voice: Phone,
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return `${Math.max(1, Math.round(diffMs / 60_000))}m`;
  if (diffH < 24) return `${Math.round(diffH)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function InboxQueue({ items, unavailable, needsYou }: {
  items: UnifiedInboxItem[];
  unavailable: InboxQueueUnavailable;
  needsYou: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Run paths keyed by item id — live for this response only; see the note above. */
  const [runPaths, setRunPaths] = useState<Record<string, string>>({});
  // One submission id per ROW, so a second tap after a failed response is the
  // same request rather than a second one. Keyed by the item id — keyed by
  // position, the next row would reuse this row's id and the server would
  // answer with the request that id already made.
  const submissionIds = useRef<Record<string, string>>({});

  const missing = (['messages', 'paperwork', 'communications'] as const).filter((k) => unavailable[k]);

  async function handleIt(item: UnifiedInboxItem) {
    if (busyId) return;
    setBusyId(item.id);
    submissionIds.current[item.id] ||= newSubmissionId();
    const result = await handleInboxMessageAction(item.rowId, submissionIds.current[item.id]);
    setBusyId(null);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    if (result.runPath) setRunPaths((prev) => ({ ...prev, [item.id]: result.runPath as string }));
    success(t('inboxQueue.bubalyIsOnIt'));
    // Re-read from the server so "Handled" comes from the row, not from here.
    router.refresh();
  }

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
          <InboxIcon className="h-4 w-4 text-brand-text" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">{t('inboxQueue.oneHouseholdQueue')}</h2>
          <p className="text-xs text-muted">{t('inboxQueue.mailPaperworkAndCallsRanked')}</p>
        </div>
        {needsYou > 0 && (
          <span className="flex-shrink-0 rounded-full bg-brand/15 px-2.5 py-1 text-xs font-semibold text-brand-text">
            {t('inboxQueue.needsYouCount', { count: needsYou })}
          </span>
        )}
      </div>

      {missing.length > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">{t('inboxQueue.partOfTheQueueIsMissing')}</p>
            <p className="text-[11px] text-muted">{t('inboxQueue.aSourceDidNotAnswerRetry')}</p>
          </div>
          <button type="button" onClick={() => router.refresh()}
            className="flex-shrink-0 rounded-lg bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-400 transition hover:bg-amber-500/25">
            {t('inboxQueue.retry')}
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface/30">
        {items.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <InboxIcon className="mb-3 h-7 w-7 text-muted opacity-60" />
            <p className="text-sm font-semibold">{t('inboxQueue.nothingIsWaiting')}</p>
            <p className="mt-1 text-xs text-muted">{t('inboxQueue.mailTextsCallsAndPaperwork')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {items.map((item) => {
              const reason = REASON_STYLE[item.reason];
              const source = SOURCE_META[item.source];
              const ChannelIcon = CHANNEL_ICON[item.channel] ?? source.icon;
              const runPath = runPaths[item.id];
              return (
                <div key={item.id} className={cn('flex items-start gap-3 px-4 py-3.5', item.handled && 'opacity-70')}>
                  <div className="mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-surface text-muted">
                    <ChannelIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('truncate text-sm', item.handled ? 'font-medium' : 'font-bold')}>
                        {item.title || t('inboxQueue.untitled')}
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted">{fmtTime(item.occurredAt)}</span>
                    </div>
                    {item.snippet && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{item.snippet}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', reason.className)}>
                        {t(reason.labelKey)}
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">
                        {t(source.labelKey)}
                      </span>
                      {item.dueOn && (
                        <span className="text-[10px] text-muted">{t('inboxQueue.dueOn', { date: item.dueOn })}</span>
                      )}
                      {item.handled && (
                        <span className="flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
                          <Check className="h-3 w-3" /> {t('inboxQueue.handled')}
                        </span>
                      )}
                      {runPath && (
                        <Link href={runPath} className="text-[10px] font-semibold text-brand-text hover:underline">
                          {t('inboxQueue.openTheRun')}
                        </Link>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                    {item.canHandle && (
                      <button type="button" onClick={() => void handleIt(item)} disabled={busyId !== null}
                        className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50">
                        {busyId === item.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Sparkles className="h-3 w-3" />}
                        {t('inboxQueue.handleIt')}
                      </button>
                    )}
                    <Link href={item.href}
                      className="flex items-center gap-0.5 text-[11px] font-semibold text-muted transition hover:text-fg">
                      {t('inboxQueue.open')} <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
