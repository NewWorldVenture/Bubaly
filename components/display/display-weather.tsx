'use client';

// Shared geolocation weather for the Kitchen Display — powers both the always-on
// header chip and the full Weather tile. One geolocation request per mount; the
// forecast is Fahrenheit-native (open-meteo), converted to the family's chosen
// unit via the pure engine. Location is remembered in localStorage so an
// always-on panel re-hydrates without re-prompting.
import { createContext, useContext, useEffect, useState } from 'react';
import { MapPin, CloudSun } from 'lucide-react';
import { fetchForecast, reverseGeocode, weatherInfo, type Forecast } from '@/lib/weather/open-meteo';
import { tempFromFahrenheit, type TempUnit } from '@/lib/display/ambient';

export type WeatherState = {
  status: 'loading' | 'denied' | 'ready';
  forecast: Forecast | null;
  place: string;
};

const LS_KEY = 'display.geo';

export function useDisplayWeather(): WeatherState {
  const [state, setState] = useState<WeatherState>({ status: 'loading', forecast: null, place: '' });

  useEffect(() => {
    let cancelled = false;
    async function load(lat: number, lon: number) {
      const [fc, g] = await Promise.all([fetchForecast(lat, lon, 5), reverseGeocode(lat, lon)]);
      if (cancelled) return;
      if (!fc) { setState({ status: 'denied', forecast: null, place: '' }); return; }
      setState({ status: 'ready', forecast: fc, place: g?.name ?? 'My location' });
    }

    // Re-use a remembered location immediately (kiosk re-hydration), then refresh.
    try {
      const cached = localStorage.getItem(LS_KEY);
      if (cached) { const { lat, lon } = JSON.parse(cached); if (typeof lat === 'number') void load(lat, lon); }
    } catch { /* ignore */ }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState((s) => s.status === 'ready' ? s : { status: 'denied', forecast: null, place: '' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        try { localStorage.setItem(LS_KEY, JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude })); } catch { /* ignore */ }
        void load(pos.coords.latitude, pos.coords.longitude);
      },
      () => setState((s) => s.status === 'ready' ? s : { status: 'denied', forecast: null, place: '' }),
      { timeout: 8000, maximumAge: 600_000 },
    );
    return () => { cancelled = true; };
  }, []);

  return state;
}

const WeatherContext = createContext<{ state: WeatherState; unit: TempUnit } | null>(null);

export function DisplayWeatherProvider({ unit, children }: { unit: TempUnit; children: React.ReactNode }) {
  const state = useDisplayWeather();
  return <WeatherContext.Provider value={{ state, unit }}>{children}</WeatherContext.Provider>;
}
function useWeatherCtx() {
  const ctx = useContext(WeatherContext);
  return ctx ?? { state: { status: 'loading', forecast: null, place: '' } as WeatherState, unit: 'F' as TempUnit };
}

/** Compact header chip: icon + current temp + place. Renders nothing until ready. */
export function WeatherChip() {
  const { state, unit } = useWeatherCtx();
  if (state.status !== 'ready' || !state.forecast) return null;
  const info = weatherInfo(state.forecast.current.code, state.forecast.current.isDay);
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/10 px-3 py-1.5 backdrop-blur-md">
      <span className="text-2xl leading-none">{info.icon}</span>
      <div className="leading-tight">
        <p className="text-lg font-bold tabular-nums">{tempFromFahrenheit(state.forecast.current.temp, unit)}</p>
        <p className="max-w-[10ch] truncate text-[10px] text-white/60">{state.place}</p>
      </div>
    </div>
  );
}

/** Full Weather tile body — current conditions + a 3-day strip. */
export function WeatherTile() {
  const { state, unit } = useWeatherCtx();
  if (state.status === 'loading') return <div className="h-full animate-pulse rounded-xl bg-white/5" />;
  if (state.status === 'denied' || !state.forecast) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-white/50">
        <CloudSun className="h-9 w-9" />
        <p className="mt-2 text-sm">Enable location for weather</p>
      </div>
    );
  }
  const f = state.forecast;
  const info = weatherInfo(f.current.code, f.current.isDay);
  return (
    <div className="flex h-full flex-col">
      <p className="flex items-center gap-1 text-xs text-white/50"><MapPin className="h-3 w-3" />{state.place}</p>
      <div className="mt-1 flex items-center gap-3">
        <span className="text-5xl leading-none">{info.icon}</span>
        <div>
          <p className="text-5xl font-black leading-none">{tempFromFahrenheit(f.current.temp, unit)}</p>
          <p className="mt-0.5 text-sm text-white/60">{info.label} · feels {tempFromFahrenheit(f.current.feelsLike, unit)}</p>
        </div>
      </div>
      <div className="mt-auto flex justify-between gap-1 pt-3">
        {f.daily.slice(1, 4).map((d) => (
          <div key={d.date} className="flex-1 rounded-xl bg-white/5 py-2 text-center">
            <p className="text-[11px] text-white/50">{new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</p>
            <p className="text-xl leading-tight">{weatherInfo(d.code).icon}</p>
            <p className="text-sm font-bold">{tempFromFahrenheit(d.tempMax, unit)}</p>
            <p className="text-[11px] text-white/40">{tempFromFahrenheit(d.tempMin, unit)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
