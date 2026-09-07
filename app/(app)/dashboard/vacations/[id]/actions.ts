'use server';

// Vacation detail server actions.
//
// TRAVEL DISRUPTION. A flight slips two hours, or a hotel cancels the night
// before. This action re-flows the family's OWN itinerary rows through
// `lib/services/trips` (which uses the pure `lib/vacations/disruption.ts`
// rules), records what happened as a `note` itinerary item, and tells the
// family. What it never does is claim a rebooking: nothing here contacts an
// airline, a hotel or a restaurant, so `toRebook` comes back as work a PERSON
// still owns and the UI says exactly that.

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { notify } from '@/lib/services/notifications';
import { scopeFromUserContext } from '@/lib/services/scope';
import { reportTripDisruption, type DisruptionRequest, type ReportedDisruption } from '@/lib/services/trips';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export type DisruptionBooking = { id: string; label: string; detail: string };

export type DisruptableBookings =
  | { ok: true; flights: DisruptionBooking[]; lodging: DisruptionBooking[] }
  | { ok: false; error: string };

/** The flights and stays a disruption can be reported against. Fails closed — an empty list and a failed read are different facts. */
export async function listDisruptableBookingsAction(vacationId: string): Promise<DisruptableBookings> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const [flights, lodging] = await Promise.all([
    supabase.from('vacation_flights').select('id, airline, flight_number, depart_airport, arrive_airport, arrive_at, depart_at')
      .eq('family_id', familyId).eq('vacation_id', vacationId).order('depart_at', { ascending: true }).limit(100),
    supabase.from('vacation_lodging').select('id, name, check_in, check_out')
      .eq('family_id', familyId).eq('vacation_id', vacationId).order('check_in', { ascending: true }).limit(100),
  ]);
  const readError = flights.error ?? lodging.error;
  if (readError) {
    console.error('[vacations] disruption booking read failed', readError);
    return { ok: false, error: t('vacationDisruption.couldNotLoadBookings') };
  }

  return {
    ok: true,
    flights: (flights.data ?? []).map((f) => ({
      id: f.id,
      label: [f.airline, f.flight_number].filter(Boolean).join(' ').trim() || t('vacationDisruption.untitledFlight'),
      detail: [f.depart_airport, f.arrive_airport].filter(Boolean).join(' → ') || (f.depart_at ?? ''),
    })),
    lodging: (lodging.data ?? []).map((l) => ({
      id: l.id,
      label: l.name,
      detail: [l.check_in, l.check_out].filter(Boolean).join(' – '),
    })),
  };
}

export type DisruptionActionInput = {
  vacationId: string;
  kind: 'flight' | 'lodging';
  bookingId: string;
  /** 'delayed' carries `delayMinutes`; 'cancelled' ignores it. */
  outcome: 'delayed' | 'cancelled';
  delayMinutes?: number | null;
};

export type DisruptionActionResult =
  | {
      ok: true;
      summary: string;
      noChange: boolean;
      shifted: ReportedDisruption['plan']['shiftedItems'];
      toRebook: ReportedDisruption['plan']['toRebook'];
      /** True only when notification rows were actually written. */
      notified: boolean;
      recorded: boolean;
    }
  | { ok: false; error: string };

export async function reportDisruptionAction(input: DisruptionActionInput): Promise<DisruptionActionResult> {
  const t = await getTranslations();
  if (!input.vacationId?.trim() || !input.bookingId?.trim()) {
    return { ok: false, error: t('vacationDisruption.pickABooking') };
  }
  const cancelled = input.outcome === 'cancelled';
  const delayMinutes = cancelled ? 0 : Math.round(Number(input.delayMinutes ?? 0));
  if (!cancelled && (!Number.isFinite(delayMinutes) || delayMinutes <= 0)) {
    return { ok: false, error: t('vacationDisruption.enterADelayInMinutes') };
  }

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  const request: DisruptionRequest = { kind: input.kind, bookingId: input.bookingId, delayMinutes, cancelled };
  const res = await reportTripDisruption(scope, input.vacationId, request);
  if (!res.ok) return { ok: false, error: res.error };

  const { plan, applied, booking } = res.data;

  // The family hears about it only when something actually changed. A
  // "nothing moved" report is not news.
  let notified = false;
  if (!plan.noop) {
    const sent = await notify(scope, {
      recipients: 'family',
      type: 'system',
      title: `Travel update: ${booking.label}`,
      body: plan.summary,
      relatedType: 'vacations',
      relatedId: input.vacationId,
      urgent: true,
    });
    if (!sent.ok) console.error('[vacations] disruption notify failed', sent.error);
    notified = sent.ok && sent.data.created > 0;
  }

  revalidatePath(`/dashboard/vacations/${input.vacationId}/travel`);
  revalidatePath(`/dashboard/vacations/${input.vacationId}/itinerary`);

  return {
    ok: true,
    summary: plan.summary,
    noChange: plan.noop,
    shifted: plan.shiftedItems,
    toRebook: plan.toRebook,
    notified,
    // Honest: the note row is what makes this a record rather than a claim.
    recorded: applied.noteItemId !== null,
  };
}
