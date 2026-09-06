'use client';

// The Super Admin Notification Center — the admin-console bell. Surfaces the
// whole super-admin front door: new feedback + bugs, GitHub sync relays, support
// tickets, and Trust & Safety reports (admin_notifications, service-role fed).
// Unread badge, dropdown with deep links, mark-all-read + mark-on-open. Pending
// family invites ride along as a synthetic top item so nothing is lost.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  Bell, MessageSquare, Bug, Github, LifeBuoy, ShieldAlert, Info, Check, UserPlus, Sparkles, CreditCard, TrendingDown,
} from 'lucide-react';
import { adminNoteKindMeta, badgeText, type AdminNotificationRow } from '@/lib/admin/notifications';
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
  return `${Math.floor(s / 86400)}d ago`;
}

export function AdminNotificationBell({ notifications, pendingInviteCount }: {
  notifications: AdminNotificationRow[];
  pendingInviteCount: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const unread = notifications.filter((n) => !n.is_read).length;
  const badge = badgeText(unread + (pendingInviteCount > 0 ? 1 : 0));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function markAll() {
    if (unread === 0) return;
    start(async () => {
      const result = await markAdminNotesReadAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-full glass hover:bg-elevated focus-ring"
      >
        <Bell className="h-5 w-5" />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-xl popover-surface shadow-glass animate-fade-in sm:w-96">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <p className="text-sm font-bold">{t('adminNotificationBell.notifications')}</p>
            {unread > 0 && (
              <button type="button" onClick={markAll} disabled={pending}
                className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline disabled:opacity-50">
                <Check className="h-3.5 w-3.5" /> {t('adminNotificationBell.markAllRead')}
              </button>
            )}
          </div>

          {error && <p role="alert" className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</p>}

          <div className="max-h-[60vh] overflow-y-auto">
            {/* Pending invites — a live count, not an admin_notifications row */}
            {pendingInviteCount > 0 && (
              <Link href="/admin/users?tab=invitations" onClick={() => setOpen(false)}
                className="flex items-start gap-3 border-b border-border/40 bg-brand/5 px-4 py-3 transition hover:bg-elevated">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand-text"><UserPlus className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-fg">{pendingInviteCount} {t('adminNotificationBell.pendingInvite')}{pendingInviteCount === 1 ? '' : 's'}</p>
                  <p className="text-xs text-muted">{t('adminNotificationBell.waitingForFamiliesToAcceptReview')}</p>
                </div>
              </Link>
            )}

            {notifications.length === 0 && pendingInviteCount === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">{t('adminNotificationBell.youreAllCaughtUp')}</p>
            ) : (
              notifications.map((n) => {
                const Icon = ICONS[n.kind] ?? (n.kind === 'feedback_new' ? Bug : Info);
                const meta = adminNoteKindMeta(n.kind);
                const inner = (
                  <>
                    <span className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated', meta.tone)}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('text-[10px] font-bold uppercase tracking-wide', meta.tone)}>{meta.label}</span>
                        {!n.is_read && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                        <span className="ml-auto text-[11px] text-muted/60">{timeAgo(n.created_at)}</span>
                      </div>
                      <p className="mt-0.5 text-sm font-semibold text-fg">{n.title}</p>
                      {n.body && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-muted">{n.body}</p>}
                    </div>
                  </>
                );
                const cls = cn('flex items-start gap-3 border-b border-border/40 px-4 py-3 transition hover:bg-elevated', !n.is_read && 'bg-brand/[0.04]');
                return n.url
                  ? <Link key={n.id} href={n.url} onClick={() => setOpen(false)} className={cls}>{inner}</Link>
                  : <div key={n.id} className={cls}>{inner}</div>;
              })
            )}
          </div>

          <Link href="/admin/notifications" onClick={() => setOpen(false)}
            className="block border-t border-border/60 px-4 py-2.5 text-center text-xs font-semibold text-brand-text hover:bg-elevated">
            {t('adminNotificationBell.seeAllNotifications')}
          </Link>
        </div>
      )}
    </div>
  );
}
