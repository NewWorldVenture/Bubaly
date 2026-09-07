'use client';

import { useMemo, useState } from 'react';
import { CloudSun, RefreshCw, MapPin } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, EmptyState, LoadingBlock } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { weatherCodeMeta, cToF, tripWeatherAdvice, type WeatherDayLike } from '@/lib/vacations/weather';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Trip = Tables<'vacations'>;
type Weather = Tables<'vacation_weather_snapshots'>;

const SEV_TONE = ['', 'text-blue-300 bg-blue-500/10', 'text-amber-300 bg-amber-500/10', 'text-rose-300 bg-rose-500/10'];

export function TripWeather({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();
  const tripQuery = useRealtimeQuery<Trip>({ table: 'vacations', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacations').select('*').eq('id', vacationId) });
  const snapshotsQuery = useRealtimeQuery<Weather>({ table: 'vacation_weather_snapshots', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacation_weather_snapshots').select('*').eq('family_id', familyId).eq('vacation_id', vacationId) });
  const trip = tripQuery.data[0];
  const snapshots = snapshotsQuery.data;
  const loading = tripQuery.loading || snapshotsQuery.loading;
  const readError = tripQuery.error || snapshotsQuery.error;
  const refreshAll = () => { void Promise.all([tripQuery.refresh(), snapshotsQuery.refresh()]); };

  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => [...snapshots].sort((a, b) => a.forecast_date.localeCompare(b.forecast_date)), [snapshots]);
  const advice = useMemo(() => tripWeatherAdvice(days as WeatherDayLike[]), [days]);

  async function refresh() {
    const loc = (location || trip?.destination || '').trim();
    if (!loc) return toastError(t('tripWeather.enterADestinationToFetch'));
    setBusy(true);
    try {
      const res = await fetch('/api/vacations/weather', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vacationId, location: loc }) });
      const data = await res.json();
      if (!res.ok) toastError(data.error || 'Failed to fetch weather');
      else success(data.note || `Updated forecast for ${data.location}`);
    } catch { toastError(t('tripWeather.networkError')); }
    setBusy(false);
  }

  if (loading) return <LoadingBlock />;
  if (readError) return <ErrorState message={t('tripWeather.couldNotLoadTripWeather')} onRetry={refreshAll} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><CloudSun className="h-5 w-5 text-brand-text" /> {t('tripWeather.weatherIntelligence')}</h2>
        <div className="flex items-end gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface/60 px-2">
            <MapPin className="h-4 w-4 text-muted" />
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={trip?.destination || 'Destination'} className="h-9 border-0 bg-transparent px-1" />
          </div>
          <Button size="sm" onClick={refresh} loading={busy}><RefreshCw className="h-4 w-4" /> {t('tripWeather.fetch')}</Button>
        </div>
      </div>

      {advice.length > 0 && (
        <div className="space-y-1.5">
          {advice.map((a, i) => (
            <div key={i} className={`rounded-xl px-3 py-2 text-sm ${SEV_TONE[a.severity]}`}>{a.text}</div>
          ))}
        </div>
      )}

      {days.length === 0 ? (
        <EmptyState icon={CloudSun} title={t('tripWeather.noForecastYet')} description={t('tripWeather.enterYourDestinationAndTap')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {days.map((d) => {
            const meta = weatherCodeMeta(d.weather_code);
            return (
              <div key={d.id} className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
                <p className="text-xs text-muted">{fmtDate(d.forecast_date)}</p>
                <p className="my-1 text-3xl">{meta.emoji}</p>
                <p className="text-sm font-medium">{meta.label}</p>
                <p className="mt-1 text-sm"><span className="font-semibold">{cToF(d.temp_high_c) ?? '—'}°</span> <span className="text-muted">/ {cToF(d.temp_low_c) ?? '—'}°F</span></p>
                {d.precip_prob != null && <p className="mt-0.5 text-xs text-blue-300">💧 {d.precip_prob}%</p>}
              </div>
            );
          })}
        </div>
      )}
      {days[0]?.location_label && <p className="text-xs text-muted">{t('tripWeather.forecastFor')} {days[0].location_label} {t('tripWeather.poweredByOpenMeteo')}</p>}
    </div>
  );
}

