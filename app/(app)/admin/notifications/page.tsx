import type { Metadata } from 'next';
import { Bell, TrendingUp } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { unreadCount, type AdminNotificationRow } from '@/lib/admin/notifications';
import { buildAdminDigest } from '@/lib/admin/digest';
import { AdminNotificationsList } from '@/components/admin/admin-notifications-list';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Notifications', robots: { index: false } };
export const dynamic = 'force-dynamic';

// The full Super Admin Notification Center history. Super-admin gating happens
// in app/(app)/admin/layout.tsx; here we just read the whole admin_notifications
// feed with the service role (the table has no client policy).
export default async function AdminNotificationsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('admin_notifications')
    .select('id, kind, title, body, url, is_read, created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) {
    console.error('[admin-notifications] notification read failed', error);
    return <AdminNotificationsReadError />;
  }

  const notifications = (data ?? []) as AdminNotificationRow[];
  const unread = unreadCount(notifications);

  // Same growth-first rollup the daily digest email sends, computed live over the
  // last 24h so the super admin gets it in-app too (reuses the tested pure lib).
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const digest = buildAdminDigest(
    notifications.filter((n) => new Date(n.created_at).getTime() >= dayAgo),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Bell className="h-6 w-6 text-brand-text" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminNotifications.notifications')}</h1>
          <p className="mt-1 text-sm text-muted">
            Every super-admin alert in one place — new feedback &amp; bugs, GitHub sync relays, support
            tickets, Trust &amp; Safety reports, new family signups, and paid conversions.
            {unread > 0 ? ` ${unread} unread.` : ' All caught up.'}
          </p>
        </div>
      </div>

      {!digest.isEmpty && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
              <TrendingUp className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('adminNotifications.last24Hours')}</p>
              <p className="text-sm font-semibold text-fg">{digest.headline}</p>
            </div>
          </div>
          {digest.byKind.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {digest.byKind.map((k) => (
                <span key={k.kind} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
                  <span className="font-semibold text-fg">{k.count}</span>
                  <span className="text-muted">{k.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <AdminNotificationsList notifications={notifications} />
    </div>
  );
}

function AdminNotificationsReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Notifications</h1>
        <p className="mt-1 text-sm text-muted">Every super-admin alert in one place.</p>
      </div>
      <ErrorState message="Could not load admin notifications from Supabase. Refresh and try again." />
      <a href="/admin/notifications" className="text-sm font-medium text-brand-text underline">Refresh notifications</a>
    </div>
  );
}
