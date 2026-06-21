import type { Metadata } from 'next';
import Link from 'next/link';
import { format } from 'date-fns';
import { CalendarClock, PenSquare } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getCalendarItems } from '@/lib/social/queries';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import type { SocialPlatform } from '@/lib/social/capabilities';

export const metadata: Metadata = { title: 'Calendar · Social' };
export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const ctx = await requireUserContext();
  const items = await getCalendarItems(ctx.active.familyId);

  // Group by day.
  const byDay = new Map<string, typeof items>();
  for (const it of items) {
    const day = format(new Date(it.scheduled_for), 'yyyy-MM-dd');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(it);
  }
  const days = [...byDay.keys()].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Content calendar</h2>
        <Link href="/dashboard/social/content-studio/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          <PenSquare className="h-4 w-4" /> Schedule a post
        </Link>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing scheduled" description="Schedule a post in the studio and it will appear here grouped by day." />
      ) : (
        <div className="space-y-4">
          {days.map((day) => (
            <Card key={day}>
              <h3 className="mb-2 text-sm font-semibold">{format(new Date(day), 'EEEE, MMM d')}</h3>
              <div className="space-y-2">
                {byDay.get(day)!.map((it) => (
                  <Link key={it.id} href={it.post_id ? `/dashboard/social/posts/${it.post_id}` : '#'} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated/50">
                    <span className="text-xs text-muted">{format(new Date(it.scheduled_for), 'p')}</span>
                    {it.platform && <PlatformDot platform={it.platform as SocialPlatform} />}
                    <span className="truncate">{it.title ?? 'Scheduled post'}</span>
                    <span className="ml-auto text-xs capitalize text-muted">{it.status}</span>
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
