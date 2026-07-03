// lib/moments/weather.ts — turn a day's forecast into a concrete packing advisory.
//
// The moment engine stays pure/I-O-free; this maps one Open-Meteo daily forecast
// (already fetched by the view, same client the Weather module uses) into a
// specific "bring an umbrella / dress warm / sunscreen" line so the weather-
// sensitive prep step says exactly what to do, not just "check the forecast".
// Temperatures are °F (the app fetches fahrenheit). Pure + tested.

export type DayWx = {
  tempMax: number;
  tempMin: number;
  precipProb: number | null;
  /** WMO weather code (Open-Meteo). */
  code: number;
};

/** A concrete advisory for the day, or null when the weather needs no callout. */
export function weatherAdvisory(day: DayWx): { label: string; hint: string } | null {
  const { tempMax, precipProb, code } = day;
  // Snow (WMO 71–77, 85–86).
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return { label: 'Snow expected — dress warm, leave early', hint: 'Boots & layers' };
  }
  // Thunderstorms (95–99).
  if (code >= 95) return { label: 'Storms possible — have a backup plan', hint: 'Watch the sky' };
  // Rain — high precip chance or drizzle/rain codes (51–67, 80–82).
  const rainy = (precipProb ?? 0) >= 60 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  if (rainy) {
    const pct = precipProb != null ? ` (${Math.round(precipProb)}%)` : '';
    return { label: `Rain likely${pct} — pack umbrellas`, hint: 'Rain jackets' };
  }
  // Cold / hot extremes.
  if (tempMax <= 40) return { label: `Cold (${Math.round(tempMax)}°) — bundle up`, hint: 'Coats & hats' };
  if (tempMax >= 85) return { label: `Hot (${Math.round(tempMax)}°) — sunscreen & water`, hint: 'Stay hydrated' };
  return null;
}

/** Local YYYY-MM-DD key for matching an ISO timestamp to a daily forecast. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
