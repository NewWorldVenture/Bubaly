// Client-side weather helpers backed by Open-Meteo (free, no API key) for
// forecasts + geocoding, and BigDataCloud (free, no key) for reverse geocoding.
// All requests run in the browser, so they work regardless of server network
// policy and never need a secret.

export type GeoResult = {
  name: string;
  admin1: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
};

export type DailyForecast = {
  date: string;
  code: number;
  tempMax: number;
  tempMin: number;
  precipProb: number | null;
  windMax: number | null;
  sunrise: string | null;
  sunset: string | null;
};

export type Forecast = {
  current: {
    temp: number;
    feelsLike: number;
    code: number;
    isDay: boolean;
    humidity: number | null;
    wind: number | null;
  };
  daily: DailyForecast[];
  timezone: string;
};

/** WMO weather code → emoji + label. */
export function weatherInfo(code: number, isDay = true): { icon: string; label: string } {
  const map: Record<number, { icon: string; label: string }> = {
    0: { icon: isDay ? '☀️' : '🌙', label: 'Clear' },
    1: { icon: isDay ? '🌤️' : '🌙', label: 'Mainly clear' },
    2: { icon: '⛅', label: 'Partly cloudy' },
    3: { icon: '☁️', label: 'Overcast' },
    45: { icon: '🌫️', label: 'Fog' },
    48: { icon: '🌫️', label: 'Rime fog' },
    51: { icon: '🌦️', label: 'Light drizzle' },
    53: { icon: '🌦️', label: 'Drizzle' },
    55: { icon: '🌦️', label: 'Heavy drizzle' },
    56: { icon: '🌧️', label: 'Freezing drizzle' },
    57: { icon: '🌧️', label: 'Freezing drizzle' },
    61: { icon: '🌧️', label: 'Light rain' },
    63: { icon: '🌧️', label: 'Rain' },
    65: { icon: '🌧️', label: 'Heavy rain' },
    66: { icon: '🌧️', label: 'Freezing rain' },
    67: { icon: '🌧️', label: 'Freezing rain' },
    71: { icon: '🌨️', label: 'Light snow' },
    73: { icon: '🌨️', label: 'Snow' },
    75: { icon: '🌨️', label: 'Heavy snow' },
    77: { icon: '🌨️', label: 'Snow grains' },
    80: { icon: '🌦️', label: 'Rain showers' },
    81: { icon: '🌦️', label: 'Rain showers' },
    82: { icon: '⛈️', label: 'Heavy showers' },
    85: { icon: '🌨️', label: 'Snow showers' },
    86: { icon: '🌨️', label: 'Snow showers' },
    95: { icon: '⛈️', label: 'Thunderstorm' },
    96: { icon: '⛈️', label: 'Thunderstorm + hail' },
    99: { icon: '⛈️', label: 'Thunderstorm + hail' },
  };
  return map[code] ?? { icon: '🌡️', label: 'Unknown' };
}

/** Forward geocode a search query to candidate locations. */
export async function geocodeCity(query: string): Promise<GeoResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? []).map((r) => ({
    name: String(r.name),
    admin1: (r.admin1 as string) ?? null,
    country: (r.country as string) ?? null,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
  }));
}

/** Reverse geocode coordinates to a place name (best-effort). */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoResult | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const name = (j.city as string) || (j.locality as string) || (j.principalSubdivision as string) || 'My Location';
    return {
      name: String(name),
      admin1: (j.principalSubdivision as string) ?? null,
      country: (j.countryName as string) ?? null,
      latitude: lat,
      longitude: lon,
    };
  } catch {
    return null;
  }
}

/** Fetch current conditions + up to 16 days of daily forecast. */
export async function fetchForecast(lat: number, lon: number, days = 14): Promise<Forecast | null> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: String(Math.min(16, Math.max(1, days))),
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) return null;
  const j = (await res.json()) as {
    current: Record<string, number>;
    daily: Record<string, (number | string)[]>;
    timezone: string;
  };
  const d = j.daily;
  const daily: DailyForecast[] = (d.time as string[]).map((date, i) => ({
    date,
    code: Number(d.weather_code[i]),
    tempMax: Number(d.temperature_2m_max[i]),
    tempMin: Number(d.temperature_2m_min[i]),
    precipProb: d.precipitation_probability_max?.[i] != null ? Number(d.precipitation_probability_max[i]) : null,
    windMax: d.wind_speed_10m_max?.[i] != null ? Number(d.wind_speed_10m_max[i]) : null,
    sunrise: (d.sunrise?.[i] as string) ?? null,
    sunset: (d.sunset?.[i] as string) ?? null,
  }));
  return {
    current: {
      temp: Number(j.current.temperature_2m),
      feelsLike: Number(j.current.apparent_temperature),
      code: Number(j.current.weather_code),
      isDay: Number(j.current.is_day) === 1,
      humidity: j.current.relative_humidity_2m != null ? Number(j.current.relative_humidity_2m) : null,
      wind: j.current.wind_speed_10m != null ? Number(j.current.wind_speed_10m) : null,
    },
    daily,
    timezone: j.timezone,
  };
}
