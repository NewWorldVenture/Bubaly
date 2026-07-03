'use client';

// Shared client hook: fetch the family's default-location daily forecast once and
// return it keyed by local day (YYYY-MM-DD), for enriching weather-sensitive
// moments ("Rain likely 70% — umbrellas"). Best-effort — no location / offline /
// error → an empty map, so callers fall back to their generic weather step.
// Used by both the Moments page and the Home "Get ready" banner (DRY).

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchForecast } from '@/lib/weather/open-meteo';
import type { DayWx } from '@/lib/moments/weather';

export function useDefaultForecast(familyId: string): Record<string, DayWx> {
  const [wxByDate, setWxByDate] = useState<Record<string, DayWx>>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: locs } = await createClient().from('weather_locations')
        .select('latitude, longitude, is_default').eq('family_id', familyId)
        .order('is_default', { ascending: false }).order('sort_order').limit(1);
      const loc = locs?.[0];
      if (!loc) return;
      const forecast = await fetchForecast(loc.latitude, loc.longitude, 16).catch(() => null);
      if (!active || !forecast) return;
      const map: Record<string, DayWx> = {};
      for (const d of forecast.daily) {
        map[d.date] = { tempMax: d.tempMax, tempMin: d.tempMin, precipProb: d.precipProb, code: d.code };
      }
      setWxByDate(map);
    })();
    return () => { active = false; };
  }, [familyId]);

  return wxByDate;
}
