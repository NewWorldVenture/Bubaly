import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { TripTabs } from '@/components/vacations/trip-tabs';
import { VACATION_KINDS, VACATION_STATUSES, lookup } from '@/lib/vacations/meta';
import { countdownLabel } from '@/lib/vacations/dates';
import { getTranslations } from '@/lib/i18n/server';

export default async function TripLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  const supabase = await createServer();
  const { data: trip } = await supabase.from('vacations').select('*').eq('id', id).maybeSingle();
  if (!trip) notFound();

  const kind = lookup(VACATION_KINDS, trip.kind);
  const status = VACATION_STATUSES.find((s) => s.value === trip.status);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/dashboard/vacations" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" /> {t('dashboardVacations.allTrips')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">{kind.emoji} {trip.title}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {trip.destination ? `${trip.destination} · ` : ''}{countdownLabel(trip.start_date)}
            </p>
          </div>
          {status && <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.tone}`}>{status.label}</span>}
        </div>
      </div>
      <TripTabs tripId={id} />
      <div>{children}</div>
    </div>
  );
}
