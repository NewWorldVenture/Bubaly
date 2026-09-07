'use client';

// Full history view for the Super Admin Notification Center. The bell only
// surfaces the last 20; this page loads the full admin_notifications feed
// (service-role, super-admin gated in the layout) with kind + unread filters,
// per-row mark-read, mark-all-read, and deep links into the relevant console.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  Bell, MessageSquare, Bug, Github, LifeBuoy, ShieldAlert, Info, Check,
  Sparkles, CreditCard, TrendingDown, ArrowUpRight,
} from 'lucide-react';
import {
  adminNoteKindMeta, filterAdminNotes, countByKind,
  type AdminNotificationRow,
} from '@/lib/admin/notifications';
import { markAdminNotesReadAction } from '@/app/(app)/admin/notifications-actions';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const ICONS: Record<string, typeof Bell> = {
  feedback_new: MessageSquare,
  github_sync: Github,
  github_error: Github,
  support_ticket: LifeBuoy,
  marketplace_report: ShieldAlert,
  family_signup: Sparkles,
  subscription: CreditCard,
  subscription_churn: TrendingDown,
  info: Info,
};

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function AdminNotificationsList({ notifications }: { notifications: AdminNotificationRow[] }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<'all' | string>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => countByKind(notifications), [notifications]);
  const unread = useMemo(() => notifications.filter((n) => !n.is_read).length, [notifications]);
  const visible = useMemo(
    () => filterAdminNotes(notifications, { kind, unreadOnly }),
    [notifications, kind, unreadOnly],
  );

  // Only the kinds actually present get a chip, in a stable, sensible order.
  const kindChips = useMemo(() => {
    const order = [
      'feedback_new', 'github_sync', 'github_error', 'support_ticket',
      'marketplace_report', 'family_signup', 'subscription', 'subscription_churn', 'info',
    ];
    return order.filter((k) => counts[k]);
  }, [counts]);

  function markRead(ids?: string[]) {
    start(async () => {
      const result = await markAdminNotesReadAction(ids);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setKind('all')}
          className={cn(
            'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
            kind === 'all' ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated',
          )}
        >
          All <span className="ml-1 opacity-60">{notifications.length}</span>
        </button>
        {kindChips.map((k) => {
          const meta = adminNoteKindMeta(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                kind === k ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated',
              )}
            >
              {meta.label} <span className="ml-1 opacity-60">{counts[k]}</span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-semibold transition',
              unreadOnly ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated',
            )}
          >
            {t('adminNotificationsList.unreadOnly')}
          </button>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markRead()}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg transition hover:bg-elevated disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> {t('adminNotificationsList.markAllRead')}
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {visible.length === 0 ? (
          <p className="px-4 py-16 text-center text-sm text-muted">
            {notifications.length === 0 ? 'No notifications yet. You’re all caught up. 🎉' : 'Nothing matches these filters.'}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {visible.map((n) => {
              const Icon = ICONS[n.kind] ?? (n.kind === 'feedback_new' ? Bug : Info);
              const meta = adminNoteKindMeta(n.kind);
              return (
                <li
                  key={n.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-4 transition hover:bg-elevated/60',
                    !n.is_read && 'bg-brand/[0.04]',
                  )}
                >
                  <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated', meta.tone)}>
                    <Icon className="h-4.5 w-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn('text-[10px] font-bold uppercase tracking-wide', meta.tone)}>{meta.label}</span>
                      {!n.is_read && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                      <span className="ml-auto text-[11px] text-muted/70">{timeAgo(n.created_at)}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold text-fg">{n.title}</p>
                    {n.body && <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{n.body}</p>}
                    <div className="mt-2 flex items-center gap-3">
                      {n.url && (
                        <Link
                          href={n.url}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline"
                        >
                          Open <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      )}
                      {!n.is_read && (
                        <button
                          type="button"
                          onClick={() => markRead([n.id])}
                          disabled={pending}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg disabled:opacity-50"
                        >
                          <Check className="h-3 w-3" /> Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
