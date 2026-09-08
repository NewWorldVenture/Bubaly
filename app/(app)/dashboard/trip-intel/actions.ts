'use server';

// Trip Intelligence server actions — persist destination research, and create /
// refresh Smart Departure plans. Saving a departure plan also writes a "🚗 Head
// out" event onto the family calendar at the computed leave-by time, and keeps
// it in sync on every refresh. 100% Supabase-wired, family-scoped via RLS.

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';
import { departureFromEstimate } from '@/lib/trips/drive-time';
import type { TripRecommendations } from '@/lib/trips/research';

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

// ── Trip research plans ───────────────────────────────────────────────────────

export async function saveTripPlanAction(input: {
  title: string;
  destination: string;
  destLat?: number | null;
  destLng?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  members?: string[];
  interests?: string | null;
  recommendations: TripRecommendations;
  weatherSummary?: string | null;
  eventId?: string | null;
}): Promise<Result<{ id: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const title = input.title.trim();
  const destination = input.destination.trim();
  if (!title || !destination) return { ok: false, error: t('actions.aTitleAndDestinationAre') };

  const { data, error } = await supabase
    .from('trip_plans')
    .insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      event_id: input.eventId ?? null,
      title,
      destination,
      dest_lat: input.destLat ?? null,
      dest_lng: input.destLng ?? null,
      start_date: input.startDate ?? null,
      end_date: input.endDate ?? null,
      members: input.members ?? [],
      interests: input.interests ?? null,
      recommendations: input.recommendations as never,
      weather_summary: input.weatherSummary ?? null,
    })
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  return { ok: true, data: { id: data!.id } };
}

export async function deleteTripPlanAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('trip_plans').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  return { ok: true };
}

// ── Smart Departure plans ─────────────────────────────────────────────────────

export interface DeparturePlanInput {
  title: string;
  eventId?: string | null;
  eventStart: string;            // ISO
  origin?: string | null;
  originLat?: number | null;
  originLng?: number | null;
  destination?: string | null;
  destLat?: number | null;
  destLng?: number | null;
  prepMinutes: number;
  parkMinutes: number;
  bufferMinutes: number;
  driveSeconds: number;
  trafficFactor: number;
  weatherDelayMinutes: number;
  weatherSummary?: string | null;
}

/** Create the "🚗 Head out for X" calendar event at the leave-by time. */
async function upsertHeadOutEvent(
  supabase: Awaited<ReturnType<typeof createServer>>,
  opts: {
    familyId: string; userId: string; existingId: string | null;
    title: string; leaveByISO: string; location: string | null;
    description: string;
  },
): Promise<string | null> {
  const endISO = new Date(new Date(opts.leaveByISO).getTime() + 5 * 60_000).toISOString();
  const fields = {
    title: `🚗 Head out for ${opts.title}`,
    starts_at: opts.leaveByISO,
    ends_at: endISO,
    location: opts.location,
    description: opts.description,
    category: 'general' as const,
  };
  if (opts.existingId) {
    const { error } = await supabase.from('calendar_events').update(fields).eq('id', opts.existingId).eq('family_id', opts.familyId);
    if (error) return null;
    return opts.existingId;
  }
  const { data, error } = await supabase
    .from('calendar_events').insert({ ...fields, family_id: opts.familyId, created_by: opts.userId }).select('id').maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export async function saveDeparturePlanAction(input: DeparturePlanInput): Promise<Result<{ id: string; leaveBy: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const title = input.title.trim();
  if (!title) return { ok: false, error: t('actions.aTitleIsRequired') };
  if (!input.eventStart) return { ok: false, error: t('actions.missingEventTime') };

  // Through the shared estimate → departure mapping (lib/trips/drive-time), the
  // same one Schedule Intelligence uses for the calendar card, so the leave-by
  // saved here and the one the event detail shows are the same minute.
  const plan = departureFromEstimate({
    driveSeconds: input.driveSeconds,
    prepMinutes: input.prepMinutes,
    parkMinutes: input.parkMinutes,
    trafficFactor: input.trafficFactor,
    weatherDelayMinutes: input.weatherDelayMinutes,
    bufferMinutes: input.bufferMinutes,
    source: 'manual',
  }, input.eventStart, new Date());

  const reminderEventId = await upsertHeadOutEvent(supabase, {
    familyId: ctx.active.familyId, userId: ctx.user.id, existingId: null,
    title, leaveByISO: plan.leaveByISO, location: input.origin ?? null,
    description: `Leave by ${new Date(plan.leaveByISO).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} to reach ${input.destination ?? 'your destination'} on time. ${input.weatherSummary ? `Weather: ${input.weatherSummary}.` : ''}`.trim(),
  });

  const { data, error } = await supabase
    .from('departure_plans')
    .insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      event_id: input.eventId ?? null,
      reminder_event_id: reminderEventId,
      title,
      origin: input.origin ?? null,
      origin_lat: input.originLat ?? null,
      origin_lng: input.originLng ?? null,
      destination: input.destination ?? null,
      dest_lat: input.destLat ?? null,
      dest_lng: input.destLng ?? null,
      event_start: input.eventStart,
      prep_minutes: input.prepMinutes,
      park_minutes: input.parkMinutes,
      buffer_minutes: input.bufferMinutes,
      drive_seconds: input.driveSeconds,
      traffic_factor: input.trafficFactor,
      weather_delay_minutes: input.weatherDelayMinutes,
      weather_summary: input.weatherSummary ?? null,
      leave_by: plan.leaveByISO,
      last_checked_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  revalidatePath('/dashboard/calendar');
  return { ok: true, data: { id: data!.id, leaveBy: plan.leaveByISO } };
}

/**
 * Re-compute an existing departure plan from fresh live numbers (drive time,
 * traffic, weather) and keep the linked calendar event in sync. This is the
 * "continuously monitor and adjust" path.
 */
export async function refreshDeparturePlanAction(input: {
  id: string;
  driveSeconds: number;
  trafficFactor: number;
  weatherDelayMinutes: number;
  weatherSummary?: string | null;
}): Promise<Result<{ leaveBy: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: existing, error: fetchErr } = await supabase
    .from('departure_plans')
    .select('id, title, event_start, prep_minutes, park_minutes, buffer_minutes, destination, origin, reminder_event_id')
    .eq('id', input.id).eq('family_id', ctx.active.familyId).maybeSingle();
  if (fetchErr) return { ok: false, error: describeDbError(fetchErr) };
  if (!existing) return { ok: false, error: t('actions.departurePlanNotFound') };

  const plan = departureFromEstimate({
    driveSeconds: input.driveSeconds,
    prepMinutes: existing.prep_minutes,
    parkMinutes: existing.park_minutes,
    trafficFactor: input.trafficFactor,
    weatherDelayMinutes: input.weatherDelayMinutes,
    bufferMinutes: existing.buffer_minutes,
    source: 'manual',
  }, existing.event_start, new Date());

  const reminderEventId = await upsertHeadOutEvent(supabase, {
    familyId: ctx.active.familyId, userId: ctx.user.id, existingId: existing.reminder_event_id,
    title: existing.title, leaveByISO: plan.leaveByISO, location: existing.origin,
    description: `Updated: leave by ${new Date(plan.leaveByISO).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} to reach ${existing.destination ?? 'your destination'} on time. ${input.weatherSummary ? `Weather: ${input.weatherSummary}.` : ''}`.trim(),
  });

  const { error } = await supabase
    .from('departure_plans')
    .update({
      drive_seconds: input.driveSeconds,
      traffic_factor: input.trafficFactor,
      weather_delay_minutes: input.weatherDelayMinutes,
      weather_summary: input.weatherSummary ?? null,
      leave_by: plan.leaveByISO,
      reminder_event_id: reminderEventId,
      last_checked_at: new Date().toISOString(),
    })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  revalidatePath('/dashboard/calendar');
  return { ok: true, data: { leaveBy: plan.leaveByISO } };
}

export async function deleteDeparturePlanAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Remove the linked head-out calendar event too.
  const { data: existing } = await supabase
    .from('departure_plans').select('reminder_event_id').eq('id', input.id).eq('family_id', ctx.active.familyId).maybeSingle();
  if (existing?.reminder_event_id) {
    await supabase.from('calendar_events').delete().eq('id', existing.reminder_event_id).eq('family_id', ctx.active.familyId);
  }
  const { error } = await supabase
    .from('departure_plans').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
