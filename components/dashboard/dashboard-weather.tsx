'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CloudSun, MapPin } from 'lucide-react';
import { fetchForecast, reverseGeocode, weatherInfo } from '@/lib/weather/open-meteo';

type State =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'ready'; temp: number; icon: string; label: string; place: string; hi: number; lo: number };

/** Compact, real current-conditions widget for the dashboard header. Uses the
 *  browser's location; shows nothing fabricated and links to the full page. */
export function DashboardWeather() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'denied' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const [f, g] = await Promise.all([
          fetchForecast(latitude, longitude, 1),
          reverseGeocode(latitude, longitude),
        ]);
        if (cancelled) return;
        if (!f) { setState({ status: 'denied' }); return; }
        const info = weatherInfo(f.current.code, f.current.isDay);
        setState({
          status: 'ready',
          temp: Math.round(f.current.temp),
          icon: info.icon,
          label: info.label,
          place: g?.name ?? 'My location',
          hi: Math.round(f.daily[0]?.tempMax ?? f.current.temp),
          lo: Math.round(f.daily[0]?.tempMin ?? f.current.temp),
        });
      },
      () => { if (!cancelled) setState({ status: 'denied' }); },
      { timeout: 8000, maximumAge: 600_000 },
    );
    return () => { cancelled = true; };
  }, []);

  if (state.status === 'loading') {
    return <div className="hidden h-[58px] w-44 animate-pulse rounded-2xl border border-border bg-surface/40 sm:block" />;
  }

  if (state.status === 'denied') {
    return (
      <Link href="/dashboard/weather" className="hidden items-center gap-2 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted transition hover:bg-elevated sm:flex">
        <CloudSun className="h-5 w-5" /> Weather
      </Link>
    );
  }

  return (
    <Link href="/dashboard/weather" className="hidden items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-2.5 transition hover:bg-elevated sm:flex">
      <span className="text-3xl leading-none">{state.icon}</span>
      <div>
        <p className="text-xl font-bold leading-none">{state.temp}°</p>
        <p className="flex items-center gap-1 text-[11px] text-muted"><MapPin className="h-3 w-3" />{state.place}</p>
      </div>
      <div className="border-l border-border pl-3 text-[11px] text-muted">
        <p>{state.label}</p>
        <p>H {state.hi}° · L {state.lo}°</p>
      </div>
    </Link>
  );
}
