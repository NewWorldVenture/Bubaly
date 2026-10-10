// Server-side weather fetching via Open-Meteo (free, no API key, real data).
// Geocodes a place name then pulls a daily forecast. Used by the weather API route.

import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

export type GeoResult = { name: string; latitude: number; longitude: number; country?: string };

export async function geocode(place: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const res = await fetchWithDeadline(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await readBoundedResponseJson<{ results?: Array<{ name: string; latitude: number; longitude: number; country?: string }> }>(res, 512 * 1024);
  const r = data?.results?.[0];
  if (!r) return null;
  return { name: r.name, latitude: r.latitude, longitude: r.longitude, country: r.country };
}

export type ForecastDay = {
  forecast_date: string;
  temp_high_c: number | null;
  temp_low_c: number | null;
  precip_prob: number | null;
  precip_mm: number | null;
  wind_kph: number | null;
  weather_code: number | null;
};

/** How far ahead Open-Meteo forecasts; a trip starting later than this has no forecast yet. */
export const FORECAST_HORIZON_DAYS = 15;

/**
 * Daily forecast between start/end (Open-Meteo supports ~16 days out).
 *
 * A trip that starts beyond the horizon gets NO days — not the default
 * week-from-today Open-Meteo answers when the dates are left off. That week
 * used to be cached under the trip and read as its weather by the packing
 * list, the readiness card and the recommendations, a month early.
 */
export async function fetchForecast(lat: number, lon: number, start?: string | null, end?: string | null, now: Date = new Date()): Promise<ForecastDay[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weathercode,wind_speed_10m_max',
    timezone: 'auto',
  });
  if (start && end) {
    const within = new Date(start).getTime() <= now.getTime() + 1000 * 60 * 60 * 24 * FORECAST_HORIZON_DAYS;
    if (!within) return [];
    params.set('start_date', start);
    params.set('end_date', end);
  }
  const res = await fetchWithDeadline(`https://api.open-meteo.com/v1/forecast?${params}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const data = await readBoundedResponseJson<{ daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    precipitation_sum?: (number | null)[];
    wind_speed_10m_max?: (number | null)[];
    weathercode?: (number | null)[];
  } }>(res, 1 * 1024 * 1024);
  const d = data?.daily;
  if (!d?.time) return [];
  return d.time.map((date: string, i: number): ForecastDay => ({
    forecast_date: date,
    temp_high_c: d.temperature_2m_max?.[i] ?? null,
    temp_low_c: d.temperature_2m_min?.[i] ?? null,
    precip_prob: d.precipitation_probability_max?.[i] ?? null,
    precip_mm: d.precipitation_sum?.[i] ?? null,
    wind_kph: d.wind_speed_10m_max?.[i] ?? null,
    weather_code: d.weathercode?.[i] ?? null,
  }));
}
