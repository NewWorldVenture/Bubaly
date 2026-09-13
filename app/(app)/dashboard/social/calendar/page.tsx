import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, PenSquare } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getCalendarItems } from '@/lib/social/queries';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import type { SocialPlatform } from '@/lib/social/capabilities';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { formatScheduledTime, scheduleDisplayTimezone, scheduledDay, scheduleStatusKey } from '@/lib/social/schedule-time';

export const metadata: Metadata = { title: 'Calendar · Social' };
export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const ctx = await requireUserContext();
  const items = await getCalendarItems(ctx.active.familyId);

  // Each saved schedule carries its own zone; legacy rows show explicit UTC.
  const byDay = new Map<string, typeof items>();
  for (const it of items) {
    const timezone = scheduleDisplayTimezone(it.metadata);
    const day = `${scheduledDay(it.scheduled_for, timezone) ?? 'unknown'}|${timezone}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(it);
  }
  const days = [...byDay.keys()].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('dashboardSocialCalendar.contentCalendar')}</h2>
        <Link href="/dashboard/social/content-studio/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          <PenSquare className="h-4 w-4" /> {t('dashboardSocialCalendar.scheduleAPost')}
        </Link>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={CalendarClock} title={t('dashboardSocialCalendar.nothingScheduled')} description={t('calendar.scheduleAPostInThe')} />
      ) : (
        <div className="space-y-4">
          {days.map((day) => (
            <Card key={day}>
              <h3 className="mb-2 text-sm font-semibold">{day.replace('|', ' · ')}</h3>
              <div className="space-y-2">
                {byDay.get(day)!.map((it) => (
                  <Link key={it.id} href={it.post_id ? `/dashboard/social/posts/${it.post_id}` : '#'} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated/50">
                    <span className="text-xs text-muted">{formatScheduledTime(it.scheduled_for, scheduleDisplayTimezone(it.metadata), locale.code)}</span>
                    {it.platform && <PlatformDot platform={it.platform as SocialPlatform} />}
                    <span className="truncate">{it.title ?? 'Scheduled post'}</span>
                    <span className="ml-auto text-xs text-muted">{scheduleStatusKey(it.metadata) ? t(scheduleStatusKey(it.metadata)) : it.status.replace(/_/g, ' ')}</span>
                  </Link>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
