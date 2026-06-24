'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin, Plus, Search, Star, Trash2, LocateFixed, Wind, Droplets, X } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import {
  fetchForecast, geocodeCity, reverseGeocode, weatherInfo,
  type Forecast, type GeoResult,
} from '@/lib/weather/open-meteo';
import type { Tables } from '@/lib/database.types';

type SavedLocation = Tables<'weather_locations'>;

type Place = {
  key: string;
  name: string;
  admin1: string | null;
  country: string | null;
  lat: number;
  lon: number;
  isGeo?: boolean;
  id?: string; // weather_locations.id for saved places
  isDefault?: boolean;
};

const VIEWS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '5', label: '5-Day', days: 5 },
  { key: '10', label: '10-Day', days: 10 },
  { key: '14', label: '14-Day', days: 14 },
] as const;
type ViewKey = (typeof VIEWS)[number]['key'];

function placeLabel(p: Place): string {
  return [p.name, p.admin1, p.country].filter(Boolean).slice(0, 2).join(', ');
}

function dayName(date: string, i: number): string {
  if (i === 0) return 'Today';
  if (i === 1) return 'Tomorrow';
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function WeatherModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [geo, setGeo] = useState<Place | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('5');

  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);

  const places: Place[] = useMemo(() => {
    const list: Place[] = [];
    if (geo) list.push(geo);
    for (const s of saved) {
      list.push({
        key: `db:${s.id}`, id: s.id, name: s.name, admin1: s.admin1, country: s.country,
        lat: s.latitude, lon: s.longitude, isDefault: s.is_default,
      });
    }
    return list;
  }, [geo, saved]);

  const active = places.find((p) => p.key === activeKey) ?? places[0] ?? null;

  const loadSaved = useCallback(async () => {
    const { data } = await supabase.from('weather_locations').select('*').eq('family_id', familyId).order('sort_order').order('created_at');
    setSaved(data ?? []);
    return data ?? [];
  }, [supabase, familyId]);

  // Initial load: saved cities + geolocation (default to where you are).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await loadSaved();
      // Try geolocation for the default "where you are" view.
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            if (cancelled) return;
            const g = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
            const place: Place = {
              key: 'geo', isGeo: true,
              name: g?.name ?? 'My Location', admin1: g?.admin1 ?? null, country: g?.country ?? null,
              lat: pos.coords.latitude, lon: pos.coords.longitude,
            };
            if (cancelled) return;
            setGeo(place);
            setActiveKey('geo');
          },
          () => {
            if (cancelled) return;
            // Geolocation denied — fall back to the family's default/first city.
            const def = rows.find((r) => r.is_default) ?? rows[0];
            setActiveKey(def ? `db:${def.id}` : null);
            if (!def) setLoading(false);
          },
          { timeout: 8000, maximumAge: 600_000 },
        );
      } else {
        const def = rows.find((r) => r.is_default) ?? rows[0];
        setActiveKey(def ? `db:${def.id}` : null);
        if (!def) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadSaved]);

  // Fetch forecast whenever the active place changes.
  useEffect(() => {
    if (!active) return; // wait for geolocation / saved cities to resolve
    let cancelled = false;
    setLoading(true); setError(null);
    fetchForecast(active.lat, active.lon, 14)
      .then((f) => { if (!cancelled) { if (f) setForecast(f); else setError('Could not load the forecast.'); } })
      .catch(() => { if (!cancelled) setError('Could not load the forecast.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active?.key, active?.lat, active?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try { setResults(await geocodeCity(query)); }
    finally { setSearching(false); }
  }

  async function addCity(r: GeoResult) {
    const { data, error: err } = await supabase.from('weather_locations').insert({
      family_id: familyId, created_by: userId,
      name: r.name, admin1: r.admin1, country: r.country, latitude: r.latitude, longitude: r.longitude,
      sort_order: saved.length,
    }).select('id').single();
    if (err || !data) { toastError(err?.message ?? 'Could not add city'); return; }
    success(`Added ${r.name}`);
    setAdding(false); setQuery(''); setResults([]);
    await loadSaved();
    setActiveKey(`db:${data.id}`);
  }

  async function makeDefault(id: string) {
    await supabase.from('weather_locations').update({ is_default: false }).eq('family_id', familyId);
    const { error: err } = await supabase.from('weather_locations').update({ is_default: true }).eq('id', id);
    if (err) return toastError(err.message);
    success('Default city set');
    await loadSaved();
  }

  async function removeCity(id: string) {
    const { error: err } = await supabase.from('weather_locations').delete().eq('id', id);
    if (err) return toastError(err.message);
    if (activeKey === `db:${id}`) setActiveKey(geo ? 'geo' : null);
    await loadSaved();
  }

  const view_days = VIEWS.find((v) => v.key === view)!.days;
  const days = forecast?.daily.slice(0, view_days) ?? [];

  return (
    <div className="module-page space-y-5">
      <PageHeader title="Weather" description="Live conditions and forecasts for your locations." action={<AiInsight kind="weather" />} />

      {/* Location selector */}
      <div className="flex flex-wrap items-center gap-2">
        {places.map((p) => (
          <button
            key={p.key}
            onClick={() => setActiveKey(p.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition',
              active?.key === p.key ? 'border-brand/50 bg-brand/15 text-brand' : 'border-border bg-surface/40 text-muted hover:bg-elevated',
            )}
          >
            {p.isGeo ? <LocateFixed className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}
            <span className="max-w-[160px] truncate">{p.name}</span>
            {p.isDefault && <Star className="h-3 w-3 fill-current text-amber-400" />}
          </button>
        ))}
        <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted hover:bg-elevated">
          <Plus className="h-3.5 w-3.5" /> Add city
        </button>
      </div>

      {/* Add-city search */}
      {adding && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <form onSubmit={runSearch} className="flex gap-2">
            <div className="flex h-10 flex-1 items-center gap-2 rounded-xl border border-border bg-surface/60 px-3">
              <Search className="h-4 w-4 text-muted" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a city…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </div>
            <Button type="submit" loading={searching}>Search</Button>
            <button type="button" onClick={() => { setAdding(false); setQuery(''); setResults([]); }} className="grid h-10 w-10 place-items-center rounded-xl border border-border text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
          </form>
          {results.length > 0 && (
            <ul className="mt-3 divide-y divide-border/60">
              {results.map((r, i) => (
                <li key={`${r.latitude}-${r.longitude}-${i}`}>
                  <button onClick={() => addCity(r)} className="flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left text-sm hover:text-brand">
                    <span>{[r.name, r.admin1, r.country].filter(Boolean).join(', ')}</span>
                    <Plus className="h-4 w-4 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && query && results.length === 0 && <p className="mt-3 text-sm text-muted">Search to find a city to add.</p>}
        </div>
      )}

      {/* View toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="tab-bar">
          {VIEWS.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)} className={cn('tab-item', view === v.key ? 'tab-item-active' : 'tab-item-inactive')}>{v.label}</button>
          ))}
        </div>
        {active && !active.isGeo && active.id && (
          <div className="flex items-center gap-2">
            {!active.isDefault && <button onClick={() => makeDefault(active.id!)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-amber-400"><Star className="h-3.5 w-3.5" /> Set default</button>}
            <button onClick={() => removeCity(active.id!)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
          </div>
        )}
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 p-6 text-center text-sm text-danger">{error}</div>
      ) : !active ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center">
          <MapPin className="mx-auto h-10 w-10 text-muted/50" />
          <p className="mt-3 font-medium">No location yet</p>
          <p className="mt-1 text-sm text-muted">Allow location access, or add a city to see the forecast.</p>
        </div>
      ) : forecast && (
        <>
          {/* Current conditions */}
          <div className="rounded-2xl border border-border bg-gradient-to-br from-brand/10 to-blue-900/10 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  {active.isGeo ? <LocateFixed className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />} {placeLabel(active)}
                </p>
                <div className="mt-1 flex items-end gap-3">
                  <span className="text-5xl font-black">{Math.round(forecast.current.temp)}°</span>
                  <div className="pb-1">
                    <p className="text-lg font-semibold">{weatherInfo(forecast.current.code, forecast.current.isDay).label}</p>
                    <p className="text-xs text-muted">Feels like {Math.round(forecast.current.feelsLike)}°</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-4 text-xs text-muted">
                  {forecast.current.humidity != null && <span className="flex items-center gap-1"><Droplets className="h-3.5 w-3.5" /> {forecast.current.humidity}%</span>}
                  {forecast.current.wind != null && <span className="flex items-center gap-1"><Wind className="h-3.5 w-3.5" /> {Math.round(forecast.current.wind)} mph</span>}
                  {days[0] && <span>H {Math.round(days[0].tempMax)}° · L {Math.round(days[0].tempMin)}°</span>}
                </div>
              </div>
              <div className="text-7xl">{weatherInfo(forecast.current.code, forecast.current.isDay).icon}</div>
            </div>
          </div>

          {/* Daily forecast */}
          {view === 'today' ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {days[0] && [
                { label: 'High / Low', value: `${Math.round(days[0].tempMax)}° / ${Math.round(days[0].tempMin)}°` },
                { label: 'Precipitation', value: days[0].precipProb != null ? `${days[0].precipProb}%` : '—' },
                { label: 'Max wind', value: days[0].windMax != null ? `${Math.round(days[0].windMax)} mph` : '—' },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="mt-1 text-xl font-bold">{s.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border bg-surface/30">
              <ul className="divide-y divide-border/50">
                {days.map((d, i) => {
                  const info = weatherInfo(d.code);
                  return (
                    <li key={d.date} className="flex items-center gap-4 px-4 py-3">
                      <span className="w-28 shrink-0 text-sm font-medium">{dayName(d.date, i)}</span>
                      <span className="text-2xl">{info.icon}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted">{info.label}</span>
                      {d.precipProb != null && d.precipProb > 0 && (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-blue-400"><Droplets className="h-3 w-3" /> {d.precipProb}%</span>
                      )}
                      <span className="w-24 shrink-0 text-right text-sm">
                        <span className="font-semibold">{Math.round(d.tempMax)}°</span>
                        <span className="text-muted"> / {Math.round(d.tempMin)}°</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="text-center text-xs text-muted">Weather data by Open-Meteo · times in {forecast.timezone}</p>
        </>
      )}
    </div>
  );
}
