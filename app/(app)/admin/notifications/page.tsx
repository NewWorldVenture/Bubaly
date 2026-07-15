import type { Metadata } from 'next';
import { Bell } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { unreadCount, type AdminNotificationRow } from '@/lib/admin/notifications';
import { AdminNotificationsList } from '@/components/admin/admin-notifications-list';

export const metadata: Metadata = { title: 'Admin · Notifications', robots: { index: false } };
export const dynamic = 'force-dynamic';

// The full Super Admin Notification Center history. Super-admin gating happens
// in app/(app)/admin/layout.tsx; here we just read the whole admin_notifications
// feed with the service role (the table has no client policy).
export default async function AdminNotificationsPage() {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('admin_notifications')
    .select('id, kind, title, body, url, is_read, created_at')
    .order('created_at', { ascending: false })
    .limit(300);

  const notifications = (data ?? []) as AdminNotificationRow[];
  const unread = unreadCount(notifications);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Bell className="h-6 w-6 text-brand-text" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Notifications</h1>
          <p className="mt-1 text-sm text-muted">
            Every super-admin alert in one place — new feedback &amp; bugs, GitHub sync relays, support
            tickets, Trust &amp; Safety reports, new family signups, and paid conversions.
            {unread > 0 ? ` ${unread} unread.` : ' All caught up.'}
          </p>
        </div>
      </div>

      <AdminNotificationsList notifications={notifications} />
    </div>
  );
}
