import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { geocode, fetchForecast } from '@/lib/vacations/weather-fetch';

export const runtime = 'nodejs';

// Pulls a real daily forecast (Open-Meteo) for a trip's destination and caches
// it into vacation_weather_snapshots. Family-scoped through the authed client (RLS).
export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceRequestRateLimit(supabase, `vac-weather:${ctx.user.id}`, { limit: 20 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many weather requests. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const { vacationId, location } = await req.json().catch(() => ({})) as { vacationId?: string; location?: string };
  if (!vacationId || !location?.trim()) return NextResponse.json({ error: 'Missing vacationId or location' }, { status: 400 });

  // Verify the trip belongs to the caller's family (RLS-enforced read).
  const { data: trip } = await supabase.from('vacations').select('id, start_date, end_date').eq('id', vacationId).maybeSingle();
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  let geo, days;
  try {
    geo = await geocode(location.trim());
    if (!geo) return NextResponse.json({ error: `Could not find “${location}”.` }, { status: 404 });
    days = await fetchForecast(geo.latitude, geo.longitude, trip.start_date, trip.end_date);
  } catch (err) {
    console.error('Weather fetch error:', err);
    return NextResponse.json({ error: 'Weather service is temporarily unavailable.' }, { status: 502 });
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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ snapshots: rows.length, location: geo.name });
}
