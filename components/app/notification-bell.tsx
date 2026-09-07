'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { bellLabel, badgeCount } from '@/lib/tone/partner-phrasing';
import { DIGEST_NOTIFICATION_TYPES } from '@/lib/notifications/priority';
import { useApp } from './app-context';

export function NotificationBell() {
  const { familyId, userId } = useApp();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    const load = async () => {
      const { count: c, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('is_read', false)
        // Due only. A notification can be scheduled ahead — `notify()` takes an
        // explicit `sendAt`, and the AI's `notifications.notify` tool offers it
        // as "Earliest delivery" — and a badge for something that has not
        // happened yet is a nudge to open the app and find nothing. `send_at`
        // is `not null default now()` (0002_tables.sql:415), so this hides
        // nothing that is already due.
        .lte('send_at', new Date().toISOString())
        // A badge is an interrupt. `notificationPriority` says which types earn
        // one; the rest — a fixture three days out, a filter to change, a
        // shopping reminder — are still in the list and are folded into the
        // Daily Brief's "Also today", so nothing is hidden, it is just not
        // shouting. `not in` rather than `in` on purpose: a notification type
        // added after this line still counts, because being unclassified must
        // never mean being silenced.
        .not('type', 'in', `(${DIGEST_NOTIFICATION_TYPES.join(',')})`)
        .or(`user_id.eq.${userId},user_id.is.null`);
      // On a transient read failure, keep the current badge rather than falsely
      // clearing it to 0 (which would tell the user they have no notifications).
      // A realtime change or the next mount will retry.
      if (error) return;
      setCount(c ?? 0);
    };
    void load();
    const channel = supabase
      .channel(`notif-bell:${familyId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `family_id=eq.${familyId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [familyId, userId]);

  return (
    <Link
      href="/dashboard/notifications"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full glass hover:bg-elevated focus-ring"
      aria-label={bellLabel(count)}
      title={bellLabel(count)}
    >
      <Bell className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
          {badgeCount(count)}
        </span>
      )}
    </Link>
  );
}
