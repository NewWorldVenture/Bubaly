import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { geocode, fetchForecast } from '@/lib/vacations/weather-fetch';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { describeReadError } from '@/lib/supabase/settle';

export const runtime = 'nodejs';

// Pulls a real daily forecast (Open-Meteo) for a trip's destination and caches
// it into vacation_weather_snapshots. Family-scoped through the authed client (RLS).
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('weather.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  // The page in front of this is feature-gated; this endpoint was not.
  // Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/vacations']);
  if (refused) return refused;
  const limited = await enforceRequestRateLimit(supabase, `vac-weather:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: t('weather.tooManyWeatherRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('weather.requestBodyIsTooLarge') }, { status: 400 });
  const { vacationId, location } = (boundedBody.value ?? {}) as { vacationId?: string; location?: string };
  if (!vacationId || !location?.trim()) return NextResponse.json({ error: t('weather.missingVacationidOrLocation') }, { status: 400 });

  // Verify the trip belongs to the caller's family (RLS-enforced read).
  // A refused read left the binding null and took the same branch as a row
  // that genuinely is not there, so the caller was told their own trip
  // does not exist. "Not found" is a claim about their data; it has to come
  // from an answer, not from the absence of one. Fails closed either way —
  // this changes WHICH closed answer is given, not whether one is. C1-S9-38.
  const { data: trip, error: tripError } = await supabase.from('vacations').select('id, start_date, end_date').eq('id', vacationId).maybeSingle();
  if (tripError) {
    console.error('[vacations/weather] trip read failed', { vacationId, error: describeReadError(tripError) });
    return NextResponse.json({ error: t('weather.tripDataIsTemporarilyUnavailable') }, { status: 503 });
  }
  if (!trip) return NextResponse.json({ error: t('weather.tripNotFound') }, { status: 404 });

  let geo, days;
  try {
    geo = await geocode(location.trim());
    if (!geo) return NextResponse.json({ error: `Could not find “${location}”.` }, { status: 404 });
    days = await fetchForecast(geo.latitude, geo.longitude, trip.start_date, trip.end_date);
  } catch (err) {
    console.error('Weather fetch error:', err);
    return NextResponse.json({ error: t('weather.weatherServiceIsTemporarilyUnavailable') }, { status: 502 });
  }

  if (days.length === 0) return NextResponse.json({ snapshots: [], note: 'No forecast available for these dates yet (forecasts reach ~16 days out).' });

  const rows = days.map((d) => ({
    family_id: ctx!.active.familyId, vacation_id: vacationId,
    location_label: geo!.name, latitude: geo!.latitude, longitude: geo!.longitude,
    forecast_date: d.forecast_date, temp_high_c: d.temp_high_c, temp_low_c: d.temp_low_c,
    precip_prob: d.precip_prob, precip_mm: d.precip_mm, wind_kph: d.wind_kph,
    weather_code: d.weather_code, summary: null, fetched_at: new Date().toISOString(),
    created_by: ctx!.user.id,
  }));

  const { error } = await supabase
    .from('vacation_weather_snapshots')
    .upsert(rows, { onConflict: 'vacation_id,location_label,forecast_date' });
  if (error) {
    console.error('Vacation weather write failed:', error);
    return NextResponse.json({ error: t('weather.couldNotSaveTheWeather') }, { status: 500 });
  }

  return NextResponse.json({ snapshots: rows.length, location: geo.name });
}
