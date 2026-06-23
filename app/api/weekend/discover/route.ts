import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { discoveryWindow, normalizeTicketmasterResponse } from '@/lib/weekend/normalize';
import { isValidZip, RADIUS_OPTIONS, DEFAULT_RADIUS, DEFAULT_DAYS } from '@/lib/weekend/meta';

export const runtime = 'nodejs';

// Discover real local events near a ZIP within a mileage radius for the next N days
// (default 6) via the Ticketmaster Discovery API, then cache them per family.
// Requires TICKETMASTER_API_KEY; without it we tell the user to configure it
// rather than returning fabricated events.
export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const limit = rateLimit(`weekend:${ctx.user.id || clientIp(req.headers)}`, { limit: 15, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ error: 'Slow down a moment and try again.' }, { status: 429 });

  const { zip, radius, days } = await req.json().catch(() => ({})) as { zip?: string; radius?: number; days?: number };
  if (!zip || !isValidZip(zip)) return NextResponse.json({ error: 'Enter a valid 5-digit ZIP code.' }, { status: 400 });
  const radiusMiles = RADIUS_OPTIONS.includes(radius as never) ? radius! : DEFAULT_RADIUS;
  const windowDays = Number.isInteger(days) && days! >= 1 && days! <= 30 ? days! : DEFAULT_DAYS;

  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Event discovery is not configured yet. Add a TICKETMASTER_API_KEY to enable live local events.', needsConfig: true }, { status: 503 });
  }

  const { startISO, endISO } = discoveryWindow(windowDays);
  const params = new URLSearchParams({
    apikey: apiKey, postalCode: zip.trim(), radius: String(radiusMiles), unit: 'miles',
    startDateTime: startISO, endDateTime: endISO, size: '100', sort: 'date,asc',
  });

  let events;
  try {
    const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 401) return NextResponse.json({ error: 'Event provider rejected the API key.' }, { status: 502 });
      throw new Error(`Ticketmaster ${res.status}`);
    }
    events = normalizeTicketmasterResponse(await res.json());
  } catch (err) {
    console.error('Weekend discover error:', err);
    return NextResponse.json({ error: 'Event service is temporarily unavailable.' }, { status: 502 });
  }

  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  if (events.length) {
    const rows = events
      .filter((e) => e.external_id)
      .map((e) => ({ ...e, family_id: familyId, search_zip: zip.trim(), search_radius: radiusMiles, discovered_at: new Date().toISOString(), created_by: ctx!.user.id }));
    const { error } = await supabase.from('weekend_events').upsert(rows, { onConflict: 'family_id,source,external_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from('weekend_searches').insert({ family_id: familyId, zip: zip.trim(), radius_miles: radiusMiles, days: windowDays, result_count: events.length, last_run_at: new Date().toISOString(), created_by: ctx.user.id });

  return NextResponse.json({ count: events.length, zip: zip.trim(), radius: radiusMiles, days: windowDays });
}
