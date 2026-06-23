// Weather helpers — interpret Open-Meteo WMO weather codes and derive family
// travel advice. Pure (no network); the fetch lives in the API route.

export type WeatherDayLike = {
  forecast_date: string;
  temp_high_c: number | null;
  temp_low_c: number | null;
  precip_prob: number | null;
  weather_code: number | null;
};

/** WMO weather interpretation code -> short summary + emoji. */
export function weatherCodeMeta(code: number | null | undefined): { label: string; emoji: string } {
  if (code == null) return { label: 'Unknown', emoji: '❓' };
  if (code === 0) return { label: 'Clear', emoji: '☀️' };
  if (code <= 2) return { label: 'Partly cloudy', emoji: '⛅' };
  if (code === 3) return { label: 'Overcast', emoji: '☁️' };
  if (code <= 48) return { label: 'Fog', emoji: '🌫️' };
  if (code <= 57) return { label: 'Drizzle', emoji: '🌦️' };
  if (code <= 67) return { label: 'Rain', emoji: '🌧️' };
  if (code <= 77) return { label: 'Snow', emoji: '❄️' };
  if (code <= 82) return { label: 'Rain showers', emoji: '🌧️' };
  if (code <= 86) return { label: 'Snow showers', emoji: '🌨️' };
  if (code <= 99) return { label: 'Thunderstorm', emoji: '⛈️' };
  return { label: 'Unknown', emoji: '❓' };
}

export const cToF = (c: number | null | undefined): number | null =>
  c == null ? null : Math.round((c * 9) / 5 + 32);

export type WeatherAdvice = { severity: 1 | 2 | 3; text: string };

/** Family-friendly advice from a day's forecast: umbrella, heat, cold, storms. */
export function dayAdvice(day: WeatherDayLike): WeatherAdvice[] {
  const out: WeatherAdvice[] = [];
  const code = day.weather_code ?? -1;
  const hi = day.temp_high_c, lo = day.temp_low_c, p = day.precip_prob ?? 0;

  if (code >= 95) out.push({ severity: 3, text: 'Thunderstorms expected — keep an indoor backup plan.' });
  else if ((code >= 61 && code <= 82) || p >= 60) out.push({ severity: 2, text: 'Rain likely — pack umbrellas and rain jackets.' });
  else if (p >= 30) out.push({ severity: 1, text: 'Chance of rain — bring a light rain layer.' });

  if (code >= 71 && code <= 86) out.push({ severity: 2, text: 'Snow expected — pack warm, waterproof layers.' });

  if (hi != null && hi >= 35) out.push({ severity: 3, text: 'Extreme heat — hydrate, sunscreen, and plan shade breaks for kids.' });
  else if (hi != null && hi >= 30) out.push({ severity: 1, text: 'Hot day — sunscreen, hats, and water for everyone.' });

  if (lo != null && lo <= 0) out.push({ severity: 2, text: 'Below freezing — pack hats, gloves, and warm coats.' });

  return out;
}

/** Roll a forecast into the worst-severity advice across the trip. */
export function tripWeatherAdvice(days: WeatherDayLike[]): WeatherAdvice[] {
  const seen = new Map<string, WeatherAdvice>();
  for (const d of days) for (const a of dayAdvice(d)) {
    const prev = seen.get(a.text);
    if (!prev || a.severity > prev.severity) seen.set(a.text, a);
  }
  return [...seen.values()].sort((a, b) => b.severity - a.severity);
}
