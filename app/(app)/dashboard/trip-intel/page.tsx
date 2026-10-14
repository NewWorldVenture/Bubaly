import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { ErrorState } from '@/components/ui/states';
import { TripIntelModule, type UpcomingEvent, type SavedTripPlan, type SavedDeparturePlan } from '@/components/modules/trip-intel-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.tripIntelligence') };
}
export const dynamic = 'force-dynamic';

export default async function TripIntelPage() {
  const ctx = await requireFeature('/dashboard/trip-intel');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const horizon = new Date(now.getTime() + 21 * 86400000).toISOString();

  const [eventsRes, membersRes, tripRes, depRes] = await settleAll([
    // Upcoming events that have a location — these are the candidates for both
    // destination research and smart-departure planning.
    supabase.from('calendar_events')
      .select('id, title, location, starts_at, ends_at, all_day, category, assignee_id')
      .eq('family_id', familyId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', horizon)
      .not('location', 'is', null)
      .order('starts_at')
      .limit(40),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId).eq('is_active', true),
    supabase.from('trip_plans')
      .select('id, title, destination, start_date, end_date, members, interests, recommendations, weather_summary, status, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(30),
    supabase.from('departure_plans')
      .select('id, title, origin, destination, event_start, prep_minutes, park_minutes, buffer_minutes, drive_seconds, traffic_factor, weather_delay_minutes, weather_summary, leave_by, last_checked_at, dest_lat, dest_lng, origin_lat, origin_lng, status')
      .eq('family_id', familyId).eq('status', 'active').order('event_start').limit(30),
  ]);

  // A failed read is not an empty one. With the events or the members unread,
  // the page would say "No upcoming events with a location" and hide every
  // active leave-by plan — and a family re-planning a departure it cannot see
  // writes a second head-out event. A table that is not there yet (the
  // migration) is still the graceful empty below.
  const failed = [eventsRes.error, membersRes.error].find((e) => e && !isMissingTableError(e));
  if (failed) {
    console.error('[trip-intel] required read failed', failed);
    const t = await getTranslations();
    return (
      <div className="module-page space-y-4">
        <h1 className="text-xl font-bold">{t('tripIntel.tripIntelligence')}</h1>
        <ErrorState message={t('tripIntel.couldNotLoadTripIntelligence')} />
        <a href="/dashboard/trip-intel" className="inline-flex rounded-lg border border-border px-4 py-2 text-sm font-semibold transition hover:bg-elevated">{t('root.tryAgain')}</a>
      </div>
    );
  }
  const events = eventsRes.data;
  const members = membersRes.data;
  const tripPlansUnavailable = Boolean(tripRes.error) && !isMissingTableError(tripRes.error);
  const departuresUnavailable = Boolean(depRes.error) && !isMissingTableError(depRes.error);
  if (tripPlansUnavailable) console.error('[trip-intel] trip plans read failed', tripRes.error);
  if (departuresUnavailable) console.error('[trip-intel] departure plans read failed', depRes.error);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const upcoming: UpcomingEvent[] = (events ?? [])
    // Skip our own "🚗 Head out" reminder events.
    .filter((e) => !e.title.startsWith('🚗 Head out'))
    .map((e) => ({
      id: e.id,
      title: e.title,
      location: e.location ?? '',
      startsAt: e.starts_at,
      allDay: e.all_day === true,
      category: e.category,
      memberName: e.assignee_id ? memberById.get(e.assignee_id)?.display_name ?? null : null,
    }));

  // Missing-table → graceful empty (migration may not be applied yet).
  const tripPlans: SavedTripPlan[] = tripRes.error ? [] : (tripRes.data ?? []).map((t) => ({
    id: t.id, title: t.title, destination: t.destination,
    startDate: t.start_date, endDate: t.end_date,
    members: Array.isArray(t.members) ? (t.members as string[]) : [],
    interests: t.interests, weatherSummary: t.weather_summary,
    recommendations: t.recommendations as unknown as SavedTripPlan['recommendations'],
    status: t.status,
  }));

  const departurePlans: SavedDeparturePlan[] = depRes.error ? [] : (depRes.data ?? []).map((d) => ({
    id: d.id, title: d.title, origin: d.origin, destination: d.destination,
    eventStart: d.event_start, prepMinutes: d.prep_minutes, parkMinutes: d.park_minutes,
    bufferMinutes: d.buffer_minutes, driveSeconds: d.drive_seconds, trafficFactor: d.traffic_factor,
    weatherDelayMinutes: d.weather_delay_minutes, weatherSummary: d.weather_summary,
    leaveBy: d.leave_by, lastCheckedAt: d.last_checked_at,
    destLat: d.dest_lat, destLng: d.dest_lng, originLat: d.origin_lat, originLng: d.origin_lng,
  }));

  const memberOptions = (members ?? []).map((m) => ({ id: m.id, name: m.display_name, color: m.color }));

  return (
    <TripIntelModule
      upcoming={upcoming}
      memberOptions={memberOptions}
      tripPlans={tripPlans}
      departurePlans={departurePlans}
      tablesMissing={isMissingTableError(tripRes.error) || isMissingTableError(depRes.error)}
      unavailable={{ tripPlans: tripPlansUnavailable, departures: departuresUnavailable }}
    />
  );
}
