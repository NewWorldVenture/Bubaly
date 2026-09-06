'use client';

import { useState } from 'react';
import { Bell, CheckCheck, Trash2, Radar } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
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

type Notification = Tables<'notifications'>;

export function NotificationsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [markingAll, setMarkingAll] = useState(false);
  const [scanning, setScanning] = useState(false);

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
      toastError('Network error. Please try again.');
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

  const unread = data.filter((n) => !n.is_read);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Notifications"
        description={notificationsLine(unread.length)}
        action={(
          <div className="flex items-center gap-2">
            <AiInsight kind="notifications" />
            <Button variant="ghost" loading={scanning} onClick={scan}>
              <Radar className="h-4 w-4" /> Scan for updates
            </Button>
            {unread.length > 0 && (
              <Button variant="ghost" loading={markingAll} onClick={markAllRead}>
                <CheckCheck className="h-4 w-4" /> Mark all read
              </Button>
            )}
          </div>
        )}
      />

      {data.length === 0 ? (
        <EmptyState icon={Bell} title="All caught up" description="No notifications at the moment. We'll let you know when something comes up." />
      ) : (
        <Card className="p-3">
          <ul className="divide-y divide-border">
            {data.map((n) => (
              <li
                key={n.id}
                className={cn(
                  'flex items-start gap-3 py-3 cursor-pointer hover:bg-elevated/50 -mx-3 px-3 rounded-lg transition',
                  !n.is_read && 'bg-brand/5',
                )}
                onClick={() => !n.is_read && markRead(n.id)}
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface/60">
                  <Bell className={cn('h-4 w-4', n.is_read ? 'text-muted' : 'text-brand-text')} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm', !n.is_read && 'font-semibold')}>{n.title}</p>
                  {n.body && <p className="mt-0.5 text-sm text-muted">{n.body}</p>}
                  <p className="mt-1 text-xs text-muted">{fmtRelative(n.created_at)}</p>
                </div>
                <div className="flex items-center gap-2" onClick={(ev) => ev.stopPropagation()}>
                  {!n.is_read && <div className="h-2 w-2 rounded-full bg-brand" />}
                  <button onClick={() => remove(n.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
