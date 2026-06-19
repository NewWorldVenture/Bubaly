'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from './app-context';

export function NotificationBell() {
  const { familyId, userId } = useApp();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    const load = async () => {
      const { count: c } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('is_read', false)
        .or(`user_id.eq.${userId},user_id.is.null`);
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
      aria-label={`Notifications${count ? `, ${count} unread` : ''}`}
    >
      <Bell className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
