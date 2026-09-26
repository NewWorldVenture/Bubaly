'use server';

// Trip Intelligence server actions — persist destination research, and create /
// refresh Smart Departure plans. Saving a departure plan also writes a "🚗 Head
// out" event onto the family calendar at the computed leave-by time, and keeps
// it in sync on every refresh. 100% Supabase-wired, family-scoped via RLS.

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getFormat } from '@/lib/utils/format-server';
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

/**
 * The head-out event's id, or the reason the calendar write was refused.
 *
 * A bare `string | null` could not carry both: null means "there is no event",
 * and a refused UPDATE came back as that same null even though the event was
 * still on the calendar — at the OLD leave-by. The caller wrote the null back
 * over `departure_plans.reminder_event_id`, severing the link to a live event
 * and leaving the next refresh to create a second one beside it.
 */
type HeadOutResult = { ok: true; id: string | null } | { ok: false; error: string };

/**
 * Create or update the "🚗 Head out for X" calendar event at the leave-by time.
 *
 * Fails closed, like the anniversary toggle in
 * app/(app)/dashboard/relationship/actions.ts: the stored link is only changed
 * once the calendar write has actually happened.
 */
async function upsertHeadOutEvent(
  supabase: Awaited<ReturnType<typeof createServer>>,
  opts: {
    familyId: string; userId: string; existingId: string | null;
    title: string; leaveByISO: string; location: string | null;
    description: string;
  },
): Promise<HeadOutResult> {
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
    if (error) return { ok: false, error: describeDbError(error) };
    return { ok: true, id: opts.existingId };
  }
  const { data, error } = await supabase
    .from('calendar_events').insert({ ...fields, family_id: opts.familyId, created_by: opts.userId }).select('id').maybeSingle();
  if (error) return { ok: false, error: describeDbError(error) };
  return { ok: true, id: data?.id ?? null };
}

/**
 * Take back a head-out event this request has just CREATED, because the plan
 * that was to point at it was not written.
 *
 * Nothing else ever could. The link runs plan → event only, so without a plan
 * row `deleteDeparturePlanAction` has no way to find the event, and the Trip
 * Intel page hides "🚗 Head out" titles from its own list — the family would
 * see an error while every member's calendar gained a "Leave by …" reminder
 * that no plan stands behind, and a retry would add a second one beside it.
 *
 * Returns false when the event could NOT be removed, so the caller can say it
 * is still on the calendar instead of implying that nothing was written. The
 * caller then returns THAT message rather than the plan write's own error, so
 * `planError` — why the plan was not written — is logged here beside the event
 * id and the withdraw's error; otherwise the original cause would be lost.
 *
 * This is a compensating write, not a transaction. Two cases still leave the
 * event behind: this delete failing too (logged, and the family is told), and
 * the request dying between the event insert and the plan write, which no
 * code in the request survives to repair. Closing that needs both writes in
 * one database function, which every save would then depend on — and
 * production cannot currently take migrations (docs/PENDING_PROD_MIGRATIONS.md,
 * "Connectivity NO LONGER works"), so it would turn a rare orphan into every
 * Smart Departure save failing.
 */
async function withdrawHeadOutEvent(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  eventId: string,
  planError: unknown,
): Promise<boolean> {
  const { error } = await supabase.from('calendar_events').delete().eq('id', eventId).eq('family_id', familyId);
  if (error) {
    console.error('[trip-intel] a head-out event with no plan behind it could not be withdrawn', {
      eventId, familyId, planError, withdrawError: error,
    });
    return false;
  }
  return true;
}

/**
 * The departure plan's own limits, mirrored from its table
 * (00981_trip_intelligence.sql: `title` 1..200 characters, `prep_minutes`
 * 0..240, `park_minutes` and `buffer_minutes` 0..120, all INTEGER).
 *
 * `calendar_events` has none of them, so a value only the plan refuses used to
 * put the head-out event on the calendar and THEN fail the plan. The inputs'
 * HTML `max` never stopped that: the planner modal renders no <form>, so the
 * Save button's onClick runs with whatever was typed.
 */
const PLAN_LIMITS = { titleChars: 200, prepMinutes: 240, parkMinutes: 120, bufferMinutes: 120 } as const;

function wholeMinutesWithin(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

export async function saveDeparturePlanAction(input: DeparturePlanInput): Promise<Result<{ id: string; leaveBy: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // The leave-by clock goes into a calendar event the family reads, so it takes
  // THEIR locale. `toLocaleTimeString([], …)` here took the SERVER's — worse than
  // the browser-locale sites, because a server has no reader at all (I18N-002).
  const { fmtDate } = await getFormat();
  const supabase = await createServer();

  const title = input.title.trim();
  if (!title) return { ok: false, error: t('actions.aTitleIsRequired') };
  if (!input.eventStart) return { ok: false, error: t('actions.missingEventTime') };
  // Asked BEFORE the head-out event is written, so a plan the table would refuse
  // never puts anything on the family's calendar. `char_length` counts
  // characters, not UTF-16 units, so an emoji in the event's name is one.
  if (Array.from(title).length > PLAN_LIMITS.titleChars) {
    return { ok: false, error: t('actions.departureTitleTooLong') };
  }
  if (
    !wholeMinutesWithin(input.prepMinutes, PLAN_LIMITS.prepMinutes)
    || !wholeMinutesWithin(input.parkMinutes, PLAN_LIMITS.parkMinutes)
    || !wholeMinutesWithin(input.bufferMinutes, PLAN_LIMITS.bufferMinutes)
  ) {
    return { ok: false, error: t('actions.departureMinutesOutOfRange') };
  }

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

  const headOut = await upsertHeadOutEvent(supabase, {
    familyId: ctx.active.familyId, userId: ctx.user.id, existingId: null,
    title, leaveByISO: plan.leaveByISO, location: input.origin ?? null,
    description: `Leave by ${fmtDate(plan.leaveByISO, 'h:mm a')} to reach ${input.destination ?? 'your destination'} on time. ${input.weatherSummary ? `Weather: ${input.weatherSummary}.` : ''}`.trim(),
  });
  // A refused calendar write is not "no event": the insert may well have landed,
  // and saving the plan without the link would leave that event stranded and
  // duplicated on the first refresh. Report it instead.
  if (!headOut.ok) return { ok: false, error: headOut.error };

  const { data, error } = await supabase
    .from('departure_plans')
    .insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      event_id: input.eventId ?? null,
      reminder_event_id: headOut.id,
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

  if (error) {
    // The head-out event above is already on the calendar, and without this
    // plan nothing links to it. The limits checked earlier keep the common
    // refusals from getting here; what is left — the source event deleted by
    // someone else while the planner was open (the event_id foreign key), a
    // dropped connection — still must not leave it behind. If the plan did in
    // fact land, reminder_event_id's ON DELETE SET NULL clears its link and the
    // next refresh writes a fresh event, so withdrawing is safe either way.
    if (headOut.id && !(await withdrawHeadOutEvent(supabase, ctx.active.familyId, headOut.id, error))) {
      return { ok: false, error: t('actions.headOutEventLeftOnCalendar') };
    }
    return { ok: false, error: describeDbError(error) };
  }
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
  // The leave-by clock goes into a calendar event the family reads, so it takes
  // THEIR locale. `toLocaleTimeString([], …)` here took the SERVER's — worse than
  // the browser-locale sites, because a server has no reader at all (I18N-002).
  const { fmtDate } = await getFormat();
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

  const headOut = await upsertHeadOutEvent(supabase, {
    familyId: ctx.active.familyId, userId: ctx.user.id, existingId: existing.reminder_event_id,
    title: existing.title, leaveByISO: plan.leaveByISO, location: existing.origin,
    description: `Updated: leave by ${fmtDate(plan.leaveByISO, 'h:mm a')} to reach ${existing.destination ?? 'your destination'} on time. ${input.weatherSummary ? `Weather: ${input.weatherSummary}.` : ''}`.trim(),
  });
  // The calendar event is what the family actually reads. If it could not be
  // moved it still says the OLD leave-by, so persisting the new one here would
  // report success for two clocks that disagree — and writing the null back
  // would cut the link to that event and duplicate it on the next refresh.
  if (!headOut.ok) return { ok: false, error: headOut.error };

  const { error } = await supabase
    .from('departure_plans')
    .update({
      drive_seconds: input.driveSeconds,
      traffic_factor: input.trafficFactor,
      weather_delay_minutes: input.weatherDelayMinutes,
      weather_summary: input.weatherSummary ?? null,
      leave_by: plan.leaveByISO,
      reminder_event_id: headOut.id,
      last_checked_at: new Date().toISOString(),
    })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);

  if (error) {
    // A plan whose head-out event had been deleted from the calendar (the FK
    // nulled its link) just had a NEW one created above. If the link to it was
    // not written, nothing points at it and the next refresh adds another. An
    // event this refresh only MOVED is left alone: it is still the plan's.
    if (!existing.reminder_event_id && headOut.id
      && !(await withdrawHeadOutEvent(supabase, ctx.active.familyId, headOut.id, error))) {
      return { ok: false, error: t('actions.headOutEventLeftOnCalendar') };
    }
    return { ok: false, error: describeDbError(error) };
  }
  revalidatePath('/dashboard/trip-intel');
  revalidatePath('/dashboard/calendar');
  return { ok: true, data: { leaveBy: plan.leaveByISO } };
}

export async function deleteDeparturePlanAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Remove the linked head-out calendar event too — FIRST, and the plan only
  // once it is gone. The plan row is the only thing that knows which event is
  // its reminder (the link runs plan → event, and 00981's `reminder_event_id …
  // ON DELETE SET NULL` acts only when the EVENT goes). Until migration 0360 is
  // applied nothing in the database follows that link when the plan goes, so a
  // plan deleted while its event stays leaves a "🚗 Head out" reminder on every
  // member's calendar, and in the next notifications run, with nothing in Trip
  // Intel left that could remove it. With 0360's AFTER DELETE trigger in place
  // this order is still right: deleting the event first nulls the plan's link,
  // so the trigger finds nothing left to do, and a refused event delete is
  // reported here while the plan — and the way to retry — still exists.
  //
  // So a read that FAILED is not "this plan has no reminder": it used to fall
  // through to the plan delete and report ok. Nor is a refused event delete a
  // success. Either keeps the plan, and with it the way to try again. If the
  // plan delete below is the step that fails, the event is already gone and
  // the FK has cleared the link — the plan stays and a refresh re-creates it.
  const { data: existing, error: readError } = await supabase
    .from('departure_plans').select('reminder_event_id').eq('id', input.id).eq('family_id', ctx.active.familyId).maybeSingle();
  if (readError) return { ok: false, error: describeDbError(readError) };
  if (existing?.reminder_event_id) {
    const { error: eventError } = await supabase
      .from('calendar_events').delete().eq('id', existing.reminder_event_id).eq('family_id', ctx.active.familyId);
    if (eventError) return { ok: false, error: describeDbError(eventError) };
  }
  const { error } = await supabase
    .from('departure_plans').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/trip-intel');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
