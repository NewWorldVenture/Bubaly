'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Smartphone, MapPin, BatteryFull, BatteryLow, Navigation, MapPinned } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { PageHeader } from '@/components/app/page-header';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { relTime } from '@/lib/family/safety';

type Loc = Tables<'member_locations'>;
type Place = Tables<'family_places'>;

export function FindPhoneView() {
  const { familyId, members } = useApp();

  const { data: locations, loading: locationsLoading, error: locationsError, refresh: refreshLocations } = useRealtimeQuery<Loc>({
    table: 'member_locations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('member_locations').select('*').eq('family_id', familyId),
  });
  const { data: places, loading: placesLoading, error: placesError, refresh: refreshPlaces } = useRealtimeQuery<Place>({
    table: 'family_places', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_places').select('*').eq('family_id', familyId),
  });

  const locByMember = useMemo(() => new Map((locations ?? []).map((l) => [l.member_id, l])), [locations]);
  const placeById = useMemo(() => new Map((places ?? []).map((p) => [p.id, p])), [places]);
  const activeMembers = members.filter((m) => m.is_active);
  const loading = locationsLoading || placesLoading;
  const error = locationsError || placesError;
  const refresh = () => { void Promise.all([refreshLocations(), refreshPlaces()]); };

  return (
    <div className="module-page">
      <PageHeader title="Find Phone" description="See each family member's last known device location."
        action={<Link href="/dashboard/locator" className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-elevated px-5 text-sm font-semibold transition hover:bg-elevated/70"><MapPinned className="h-4 w-4" /> Family Map</Link>} />

      {loading ? <SkeletonList /> : error ? <ErrorState message="Could not load phone locations. Refresh and try again." onRetry={refresh} /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {activeMembers.map((m) => {
            const loc = locByMember.get(m.id);
            const place = loc?.place_id ? placeById.get(loc.place_id) : null;
            const where = place?.name ?? loc?.address ?? null;
            const hasCoords = loc?.latitude != null && loc?.longitude != null;
            const battery = loc?.battery ?? null;
            return (
              <div key={m.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-center gap-3">
                  <div className="relative shrink-0">
                    <Avatar name={m.display_name} color={m.color} size={44} />
                    <span className={cn('absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border-2 border-surface', loc?.is_sharing ? 'bg-emerald-500' : 'bg-muted')}>
                      <Smartphone className="h-2 w-2 text-white" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{m.display_name}</p>
                    <p className="truncate text-xs text-muted">
                      {where ? <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {where}</span> : 'No recent location'}
                      {loc ? ` · ${relTime(loc.updated_at)}` : ''}
                    </p>
                  </div>
                  {battery != null && (
                    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', battery <= 20 ? 'bg-rose-500/15 text-rose-300' : 'bg-elevated text-muted')}>
                      {battery <= 20 ? <BatteryLow className="h-3.5 w-3.5" /> : <BatteryFull className="h-3.5 w-3.5" />} {battery}%
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {hasCoords ? (
                    <a href={`https://maps.google.com/?q=${loc!.latitude},${loc!.longitude}`} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-elevated px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated/70">
                      <Navigation className="h-3.5 w-3.5" /> Open in Maps
                    </a>
                  ) : (
                    <span className="text-xs text-muted">{loc?.is_sharing ? 'Waiting for a location update…' : 'Location sharing is off for this member.'}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-center text-xs text-muted">
        Location updates come from each member&apos;s device via the Family Map. Manage sharing in{' '}
        <Link href="/dashboard/locator" className="text-brand-text">Location settings</Link>.
      </p>
    </div>
  );
}
