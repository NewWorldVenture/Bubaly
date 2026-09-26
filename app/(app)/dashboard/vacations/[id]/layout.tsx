import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { TripTabs } from '@/components/vacations/trip-tabs';
import { VACATION_KINDS, VACATION_STATUSES, lookup } from '@/lib/vacations/meta';
import { countdownLabel } from '@/lib/vacations/dates';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';

export default async function TripLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  const supabase = await createServer();
  // `notFound()` is a statement that this trip does not exist, and it is a
  // LAYOUT — so a refused read 404s every page under the trip at once. Kept for
  // a trip that really is gone. Audit C1-S9-45.
  const { data: trip, error: tripError } = await supabase.from('vacations').select('*').eq('id', id).maybeSingle();
  if (tripError) {
    console.error('[vacations/layout] trip read failed', { id, error: tripError.message });
    return (
      <div className="space-y-5">
        <ErrorState message={t('vacations.couldNotLoadThisTrip')} />
      </div>
    );
  }
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
