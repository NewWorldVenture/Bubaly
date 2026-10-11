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
import { isManager } from '@/lib/constants/roles';
import { getTranslations } from '@/lib/i18n/server';
import { notify } from '@/lib/services/notifications';
import { scopeFromUserContext } from '@/lib/services/scope';
import { markDisruptionNotified, reportTripDisruption, type DisruptionRequest, type ReportedDisruption } from '@/lib/services/trips';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';

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

  const [flights, lodging] = await settleAll([
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
      /** True only when notification rows were actually written by THIS submit. */
      notified: boolean;
      recorded: boolean;
      /**
       * This exact report was already on the itinerary: nothing moved this
       * time (`shifted` is empty) and `summary` is what was recorded then. The
       * receipt says so, rather than listing a move that never happened.
       */
      alreadyApplied: boolean;
      /** The family was told when this was first reported, so nobody was paged again. */
      previouslyNotified: boolean;
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
  // Re-flowing the shared itinerary and paging the whole family about it is a
  // manager's act — `notify` writes for the family with the service role, so
  // the role has to be checked HERE, before any write, not left to RLS. Same
  // rule as the confirmation import and the school desk.
  if (!isManager(ctx.active.role)) {
    return { ok: false, error: t('vacationDisruption.parentsOnly') };
  }
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  const request: DisruptionRequest = { kind: input.kind, bookingId: input.bookingId, delayMinutes, cancelled };
  const res = await reportTripDisruption(scope, input.vacationId, request);
  if (!res.ok) return { ok: false, error: res.error };

  const { plan, applied, booking, alreadyApplied, familyNotified } = res.data;

  // The family hears about a disruption ONCE. A "nothing moved" report is not
  // news. Delivery is tracked apart from the itinerary change: the note's
  // marker says the re-flow happened, its "notified" stamp says the family was
  // told. They used to be one fact, so a notice that failed (or a request cut
  // off after the note was written) was skipped by every retry as "already
  // applied", and the urgent travel update never went out. Now a retry of a
  // report whose notice did not land sends it — and moves nothing again.
  //
  // `relatedId` names THIS disruption (its note), and `once` drops any
  // recipient who already has a copy, read or not: a notice that was written
  // but whose stamp was not (the request died in between) is not sent twice.
  // Two submits racing through here at the same instant can still both pass
  // notify's read-then-insert guard; that needs a unique index (SQL).
  let notified = false;
  if (!plan.noop && applied.noteItemId && !familyNotified) {
    const sent = await notify(scope, {
      recipients: 'family',
      type: 'system',
      title: `Travel update: ${booking.label}`,
      body: plan.summary,
      relatedType: 'vacations',
      relatedId: `${input.vacationId}:disruption:${applied.noteItemId}`,
      urgent: true,
      once: true,
    });
    if (!sent.ok) console.error('[vacations] disruption notify failed', sent.error);
    else {
      notified = sent.data.created > 0;
      const stamped = await markDisruptionNotified(scope, input.vacationId, applied.noteItemId);
      if (!stamped.ok) console.error('[vacations] disruption notified stamp failed', stamped.error);
    }
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
    alreadyApplied,
    previouslyNotified: alreadyApplied && familyNotified,
  };
}
