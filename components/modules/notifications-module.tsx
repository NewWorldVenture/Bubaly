'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell, Check, CheckCheck, ChevronRight, Trash2, Radar, X } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { decideApproval } from '@/app/(app)/dashboard/approvals-actions';
import { setChoreStatusAction } from '@/app/(app)/dashboard/chores/actions';
import { notificationAction, type NotificationInlineAction } from '@/lib/notifications/actions';
import { partitionByPriority } from '@/lib/notifications/priority';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtRelative } from '@/lib/utils/format';
import { notificationsLine } from '@/lib/tone/partner-phrasing';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Notification = Tables<'notifications'>;

export function NotificationsModule() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [markingAll, setMarkingAll] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    try {
      const res = await fetch('/api/notifications/generate', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not scan.'); return; }
      success(json.created > 0
        ? `Added ${json.created} new notification${json.created === 1 ? '' : 's'}.`
        : "You're all caught up — nothing new.");
      void refresh();
    } catch {
      toastError(t('notificationsModule.networkErrorPleaseTryAgain'));
    } finally {
      setScanning(false);
    }
  }

  const { data, loading, error, refresh } = useRealtimeQuery<Notification>({
    table: 'notifications',
    familyId,
    deps: [familyId, userId],
    fetcher: (supabase) =>
      // Due only, matching the bell: a notice scheduled for tomorrow morning is
      // not something to read tonight. Ordering stays on `created_at` so the
      // list still reads newest-first as it always has.
      supabase.from('notifications').select('*').eq('family_id', familyId)
        .lte('send_at', new Date().toISOString())
        .or(`user_id.eq.${userId},user_id.is.null`)
        .order('created_at', { ascending: false })
        .limit(100),
  });

  async function markRead(id: string) {
    const supabase = createClient();
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    void refresh();
  }

  async function markAllRead() {
    setMarkingAll(true);
    const supabase = createClient();
    await supabase.from('notifications').update({ is_read: true })
      .eq('family_id', familyId).eq('is_read', false);
    setMarkingAll(false);
    void refresh();
  }

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('notifications').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    void refresh();
  }

  // ── Acting on a notification without leaving the list ──────────────────────
  //
  // Only the two kinds `lib/notifications/actions.ts` will hand back an inline
  // action for, and each one calls the SAME server action the owning screen
  // calls — the chores board's `setChoreStatusAction` and the approval card's
  // `decideApproval`. Nothing here writes to a table directly, so a chore
  // signed off from a notification is signed off exactly as it would be from
  // the board: same gate, same ledger, same revalidation.
  //
  // The row is marked read only AFTER the action reports success. A failure
  // leaves the notification unread and visible, which is the honest outcome —
  // the thing it was telling you about still has not happened.
  async function runInline(notificationId: string, action: NotificationInlineAction, decision?: 'approved' | 'rejected') {
    setBusyId(notificationId);
    try {
      if (action.kind === 'chore-signoff') {
        const result = await setChoreStatusAction(action.assignmentId, 'submitted');
        if (!result.ok) { toastError(result.error); return; }
        success(t('notificationActions.choreMarkedDone'));
      } else {
        const result = await decideApproval({ id: action.approvalId, decision: decision ?? 'approved' });
        if (!result.ok) { toastError(result.error); return; }
        success(t('notificationActions.decisionSaved'));
      }
      await markRead(notificationId);
    } catch (err) {
      console.error('[notifications] inline action failed', err);
      toastError(t('notificationActions.couldNotCompleteThatAction'));
    } finally {
      setBusyId(null);
    }
  }

  const unread = data.filter((n) => !n.is_read);
  // 'now' interrupts, 'digest' waits for the brief (lib/notifications/priority.ts).
  // Both halves are rendered here — the list is where you go to see everything —
  // but the quiet half is below the loud one and labelled as such, so the page
  // agrees with the bell instead of contradicting it.
  const { now: urgentRows, digest: digestRows } = partitionByPriority(data);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('notifications.notifications')}
        description={notificationsLine(unread.length)}
        action={(
          <div className="flex items-center gap-2">
            <AiInsight kind="notifications" />
            <Button variant="ghost" loading={scanning} onClick={scan}>
              <Radar className="h-4 w-4" /> {t('notifications.scanForUpdates')}
            </Button>
            {unread.length > 0 && (
              <Button variant="ghost" loading={markingAll} onClick={markAllRead}>
                <CheckCheck className="h-4 w-4" /> {t('notifications.markAllRead')}
              </Button>
            )}
          </div>
        )}
      />

      {data.length === 0 ? (
        <EmptyState icon={Bell} title={t('notifications.allCaughtUp')} description="No notifications at the moment. We'll let you know when something comes up." />
      ) : (
        <div className="space-y-4">
          {urgentRows.length > 0 && (
            <NotificationSection
              heading={t('notificationActions.needsYouNow')}
              rows={urgentRows}
              busyId={busyId}
              t={t}
              onOpen={markRead}
              onInline={runInline}
              onDelete={remove}
            />
          )}
          {digestRows.length > 0 && (
            <NotificationSection
              heading={t('notificationActions.alsoToday')}
              // Said once here and once in the brief, and nowhere else: the bell
              // does not count these, so nothing is shouting about them twice.
              subheading={t('notificationActions.alsoTodayHint')}
              rows={digestRows}
              busyId={busyId}
              t={t}
              onOpen={markRead}
              onInline={runInline}
              onDelete={remove}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One group of notifications — "Needs you now" or "Also today".
 *
 * Every row is a link to the place the notice is ABOUT (never a link back to
 * this list: `isFallback` says when there is no better destination, and then
 * the row is plain text rather than a control that goes nowhere). Chore and
 * approval rows also carry the buttons that finish the job here. All targets
 * are 44px so they can be hit on a phone, and every one of them has a name that
 * includes the notification's own title — "Approve" on its own is meaningless
 * to a screen reader working down a list of six.
 */
function NotificationSection({
  heading, subheading, rows, busyId, t, onOpen, onInline, onDelete,
}: {
  heading: string;
  subheading?: string;
  rows: Notification[];
  busyId: string | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  onOpen: (id: string) => void;
  onInline: (id: string, action: NotificationInlineAction, decision?: 'approved' | 'rejected') => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="p-3">
      <div className="px-1 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{heading}</h2>
        {subheading && <p className="mt-0.5 text-xs text-muted">{subheading}</p>}
      </div>
      <ul className="divide-y divide-border">
        {rows.map((n) => {
          const action = notificationAction(n);
          const busy = busyId === n.id;
          const body = (
            <>
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface/60">
                <Bell className={cn('h-4 w-4', n.is_read ? 'text-muted' : 'text-brand-text')} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm', !n.is_read && 'font-semibold')}>{n.title}</p>
                {n.body && <p className="mt-0.5 text-sm text-muted">{n.body}</p>}
                <p className="mt-1 text-xs text-muted">{fmtRelative(n.created_at)}</p>
              </div>
            </>
          );
          return (
            <li key={n.id} className={cn('-mx-3 flex items-start gap-2 px-3 rounded-lg', !n.is_read && 'bg-brand/5')}>
              {action.isFallback ? (
                <div className="flex min-h-11 flex-1 items-start gap-3 py-3">{body}</div>
              ) : (
                <Link
                  href={action.href}
                  onClick={() => { if (!n.is_read) onOpen(n.id); }}
                  aria-label={t('notificationActions.openNotification', { title: n.title })}
                  className="flex min-h-11 flex-1 items-start gap-3 rounded-lg py-3 transition hover:bg-elevated/50 focus-ring"
                >
                  {body}
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                </Link>
              )}
              <div className="flex shrink-0 items-center gap-1 py-2">
                {!n.is_read && <span className="mr-1 h-2 w-2 rounded-full bg-brand" aria-hidden="true" />}
                {action.inline?.kind === 'chore-signoff' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onInline(n.id, action.inline as NotificationInlineAction)}
                    aria-label={t('notificationActions.markDoneAria', { title: n.title })}
                    className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-brand-text hover:bg-elevated disabled:opacity-50 focus-ring"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">{t('notificationActions.markDone')}</span>
                  </button>
                )}
                {action.inline?.kind === 'approval-decide' && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onInline(n.id, action.inline as NotificationInlineAction, 'approved')}
                      aria-label={t('notificationActions.approveAria', { title: n.title })}
                      className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-brand-text hover:bg-elevated disabled:opacity-50 focus-ring"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden sm:inline">{t('notificationActions.approve')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onInline(n.id, action.inline as NotificationInlineAction, 'rejected')}
                      aria-label={t('notificationActions.declineAria', { title: n.title })}
                      className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-muted hover:bg-elevated hover:text-danger disabled:opacity-50 focus-ring"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden sm:inline">{t('notificationActions.decline')}</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(n.id)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-danger focus-ring"
                  aria-label={t('notificationActions.deleteAria', { title: n.title })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
