// lib/guardian/escalate.ts
// The emergency escalation itself, shared by the internal /api/guardian/escalate
// route and by the inbound SMS, WhatsApp and screening flows that detect an
// emergency. Before this lived only in the route, and nothing called the route,
// so a detected emergency never texted or called a manager.
//
// Notifies every manager (parent + adult) via push + SMS + attempted outbound call.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSms, initiateCall, isTwilioConfigured } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { claimGuardianCallback, markGuardianCallbackError, markGuardianCallbackProcessed, releaseGuardianCallback } from '@/lib/guardian/callbacks';
import { guardianEscalationEventId, guardianEscalationStableId as stableId, type GuardianEscalationInput } from '@/lib/guardian/escalation';
import { oweGuardianEscalation } from '@/lib/guardian/escalation-owed';
import { appBaseUrl } from '@/lib/server/app-url';
import { isManager } from '@/lib/constants/roles';
import { getTranslations } from '@/lib/i18n/server';
import { isValidTimezone } from '@/lib/time/zoned';

export type GuardianEscalationOutcome =
  /** The claim could not be written; nothing was read or sent. */
  | { kind: 'claim_unavailable' }
  /** Another worker holds it, or it was already processed. */
  | { kind: 'duplicate' }
  /** A read the alert depends on failed before anything was sent; the claim was given back. */
  | { kind: 'read_failed' }
  /**
   * Alerts went out (or there was nobody to alert) but the escalation row could
   * not be written; the claim is parked as `error` — final when somebody WAS
   * told (ESCALATION_SENT_UNRECORDED), so no retry sends again — and a narrow
   * second write records who, so the retry sweep does not read the row as
   * "nobody reached" either.
   */
  | { kind: 'record_failed' }
  /**
   * There was nobody to text or call: Twilio is not configured, or no active
   * manager has a phone on file. Nothing to retry, so this is recorded (with
   * `notified_member_ids` NULL rather than empty, which is how the retry sweep
   * tells it from `undelivered`), the claim is marked processed, and the
   * callers complete. The dashboard row says nobody was reached by phone, and
   * the in-app notice went out; a phone added later is for the next emergency.
   */
  | { kind: 'unreachable'; pushSent: boolean; notifiedCount: 0 }
  /**
   * A manager could have been reached, and every send to every one of them
   * failed (a Twilio 5xx, a refused connection). Recorded with nobody notified,
   * and the claim given back, so the undelivered-escalation sweep on the
   * recovery cron re-attempts it from its record for a bounded time: nothing
   * reached a phone, so a retry cannot text twice. `recorded` says whether the
   * record landed. When it did not, `owed` says whether the work item the
   * sweep lands it from (lib/guardian/escalation-owed.ts) did instead; with
   * neither, only the caller's own retry can come back for it.
   */
  | { kind: 'undelivered'; pushSent: boolean; notifiedCount: 0; recorded: boolean; owed: boolean }
  /**
   * The caller's deadline passed (or it cancelled) before any manager was
   * confirmed reached, and no further send was started once it had. Recorded
   * with nobody notified, so the undelivered-escalation sweep picks it up. A
   * send that was in flight was aborted on OUR side, which is not proof Twilio
   * refused it, so when a send had started the claim is parked as `error`
   * rather than given back: a retry inside ten minutes is a duplicate, and
   * after that it re-sends. When no send had started the claim is given back.
   * `recorded` and `owed` as for `undelivered`.
   */
  | { kind: 'interrupted'; pushSent: boolean; notifiedCount: 0; recorded: boolean; owed: boolean }
  | { kind: 'delivered'; pushSent: boolean; smsSent: boolean; callAttempted: boolean; notifiedCount: number };

export type GuardianEscalationOptions = {
  /**
   * The caller's deadline. Threaded into every Twilio request (combined there
   * with the per-request 15 s ceiling), checked before each send so no new
   * send starts after it, and never given to the database calls: once the
   * deadline has passed the record and the claim still have to be written,
   * because the record is what the retry sweep reads.
   */
  signal?: AbortSignal;
  /**
   * When the escalation was first raised, for a retry (the sweep passes the
   * record's `escalated_at`). A retry that much later says so, in the text and
   * in the call, with the original time and how long ago it was: it can reach
   * a manager hours after the emergency, and otherwise reads exactly like one
   * happening now.
   */
  originalAt?: string;
};

/**
 * The escalation claim's `error` text when a manager was texted or called and
 * the record did not land. Such an escalation is never re-sent, whichever way
 * the retry comes: the claim it marks is final (claimGuardianCallback never
 * reclaims it, so a redelivery, a replay or the SMS lane's retry finds it
 * settled), and the retry sweep leaves its record alone. It used to be honoured
 * by the sweep only, and the claim was reclaimable after ten minutes like any
 * other `error`: a late redelivery texted and called every manager again.
 */
export const ESCALATION_SENT_UNRECORDED = 'Unable to record escalation.';

/**
 * The claim's `error` text when there was nobody to text or call and the record
 * did not land. Not final: nothing reached a phone, the in-app notice has a
 * stable id, so a retry after ten minutes repeats nothing and may land the
 * record.
 */
const ESCALATION_UNREACHABLE_UNRECORDED = 'Unable to record escalation; nobody to text or call.';

/** How late a retry has to be before the alert says it is delayed. */
const DELAYED_ALERT_AFTER_MS = 5 * 60_000;

/** `2026-10-11 02:15 BST`: the same in every language, and unambiguous about its zone. */
function formatOriginalTime(at: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * The line a late retry leads with, or null when the alert is not late. In the
 * family's own zone when it can be read, otherwise UTC (named either way).
 */
async function delayedAlertLine(supabase: SupabaseClient, familyId: string, originalAt: string | undefined): Promise<string | null> {
  const first = originalAt ? Date.parse(originalAt) : Number.NaN;
  if (!Number.isFinite(first)) return null;
  const ageMs = Date.now() - first;
  if (ageMs < DELAYED_ALERT_AFTER_MS) return null;
  let timeZone = 'UTC';
  try {
    const { data, error } = await supabase.from('families').select('timezone').eq('id', familyId).maybeSingle();
    const zone = (data as { timezone?: unknown } | null)?.timezone;
    if (!error && typeof zone === 'string' && isValidTimezone(zone)) timeZone = zone;
  } catch { /* UTC, named as such. */ }
  const t = await getTranslations();
  const time = formatOriginalTime(first, timeZone);
  const minutes = Math.floor(ageMs / 60_000);
  return minutes >= 60
    ? t('guardianEscalation.delayedAlertHours', { time, hours: Math.floor(minutes / 60) })
    : t('guardianEscalation.delayedAlertMinutes', { time, minutes });
}

type Reached = { id: string; sms: boolean; call: boolean };

export async function escalateGuardianEmergency(
  supabase: SupabaseClient,
  body: GuardianEscalationInput,
  options: GuardianEscalationOptions = {},
): Promise<GuardianEscalationOutcome> {
  const { familyId, commId, escalationType, severity, description, callerNumber } = body;
  const { signal, originalAt } = options;
  const callbackId = guardianEscalationEventId(body);
  const claim = await claimGuardianCallback(supabase, 'emergency_escalation', callbackId, { finalError: ESCALATION_SENT_UNRECORDED });
  if (claim === 'unavailable') return { kind: 'claim_unavailable' };
  if (claim !== 'claimed') return { kind: 'duplicate' };

  // Get all parent/manager members with phone numbers
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, user_id, display_name, role')
    .eq('family_id', familyId)
    .eq('is_active', true);
  if (membersError) {
    // Nothing has been sent, so the claim goes back rather than to `error`: an
    // `error` row is reclaimable only after ten minutes, and inside that window
    // the caller's retry was answered `{ ok: true, duplicate: true }` — an
    // emergency escalation reported as handled when nobody had been told.
    console.error('[guardian] escalation could not load family members; releasing the claim for a retry', membersError);
    await releaseGuardianCallback(supabase, 'emergency_escalation', callbackId);
    return { kind: 'read_failed' };
  }

  // Every read the alert depends on happens before anything is sent. A failed
  // phone lookup used to read as "no phones": nobody was texted or called, and
  // the escalation was recorded as handled. Failing here, with nothing sent yet,
  // releases the claim, so a retry can take it at once without any alert being
  // sent twice. (Marking it `error` did not do that: see the members read.)
  const userIds = (members ?? [])
    .map((member) => (member as { user_id: string | null }).user_id)
    .filter((id): id is string => !!id);
  let phoneMap = new Map<string, string | null | undefined>();
  if (isTwilioConfigured() && userIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase.from('profiles').select('id, phone').in('id', userIds);
    if (profilesError) {
      console.error('[guardian] escalation could not load member phone numbers; releasing the claim for a retry', profilesError);
      await releaseGuardianCallback(supabase, 'emergency_escalation', callbackId);
      return { kind: 'read_failed' };
    }
    phoneMap = new Map((profiles ?? []).map((p: { id: string; phone?: string | null }) => [p.id, p.phone]));
  }

  const notifiedIds: string[] = [];
  let pushSent = false;
  let smsSent = false;
  let callAttempted = false;

  const callerDisplay = formatPhone(callerNumber);
  const alertTitle = severity === 'critical'
    ? `🚨 EMERGENCY — Call from ${callerDisplay}`
    : `⚠️ Urgent Call — ${callerDisplay}`;
  const alertBody = description;

  // Push notifications for all parents.
  //
  // `pushSent` is written into the guardian_escalations row below and returned
  // to the caller, so it has to mean the row LANDED. A PostgREST insert resolves
  // with { data, error } rather than throwing, so the catch never fired on a
  // failed write and `pushSent = true` ran anyway. Take the error, and only
  // claim the push on success. The id is stable so a retry of an undelivered
  // escalation does not write a second alert (23505 means it already landed).
  try {
    const { error: notifyError } = await supabase.from('notifications').insert({
      id: stableId(callbackId, 'push'),
      family_id: familyId,
      user_id: null,
      type: 'system',
      title: alertTitle,
      body: alertBody,
      related_type: commId ? 'guardian_communications' : undefined,
      related_id: commId ?? null,
    });
    if (notifyError && (notifyError as { code?: string }).code !== '23505') {
      console.error('[guardian] escalation notification write failed', { familyId, callbackId, error: notifyError });
    } else pushSent = true;
  } catch (error) {
    console.error('[guardian] escalation notification write threw', { familyId, callbackId, error });
  }

  const twilioReady = isTwilioConfigured();
  if (!twilioReady) console.error('[guardian] escalation cannot text or call: Twilio is not configured', { familyId, callbackId });
  // The manager pair this product actually has. `public.member_role` is
  // ('parent','adult','teen','child','caregiver','guest') — the list here
  // used to read ['owner', 'manager', 'parent'], and two of those three
  // match nobody, so an adult co-parent was never texted or called.
  const managers = ((members ?? []) as Array<{ id: string; user_id: string | null; display_name: string; role: string }>).filter((m) => isManager(m.role));
  // Set once a manager with a phone is found while Twilio is configured: there
  // was somebody to text or call. Without it, an escalation that reached nobody
  // is `unreachable` (nothing to retry) rather than `undelivered` (retry).
  let reachable = false;
  // Set the moment the first Twilio request is started. After that an abort
  // is not proof that nothing reached a phone (see `interrupted`).
  let sendStarted = false;
  if (twilioReady && managers.length) {
    const BASE_URL = appBaseUrl();
    const delayed = await delayedAlertLine(supabase, familyId, originalAt);
    const smsText = `[Bubaly Emergency Alert]\n${delayed ? `${delayed}\n` : ''}${alertTitle}\n${alertBody}\nReply STOP to opt out.`;
    const twimlUrl = `${BASE_URL}/api/guardian/escalate/twiml?family=${familyId}&msg=${encodeURIComponent(`${delayed ? `${delayed} ` : ''}${description.slice(0, 200)}`)}`;
    // Every manager at once, not one after another. Sequentially this was two
    // Twilio requests of up to 15 s each PER manager, so a family with three
    // managers on a slow provider could not finish inside any caller's budget;
    // together, the whole fan-out is bounded by one text plus one call. Each
    // send is skipped once the caller's deadline has passed, and the ones in
    // flight are cut off by it, so nothing keeps going detached after the
    // caller has answered 503 and asked for a retry.
    const reached = await Promise.all(managers.map(async (m): Promise<Reached | null> => {
      const phone = m.user_id ? phoneMap.get(m.user_id) : null;
      if (!phone) {
        console.error('[guardian] escalation cannot reach a manager with no phone on file', { familyId, callbackId, memberId: m.id });
        return null;
      }
      reachable = true;
      const result: Reached = { id: m.id, sms: false, call: false };

      // SMS
      if (!signal?.aborted) {
        sendStarted = true;
        try {
          await sendSms(phone, smsText, { signal });
          result.sms = true;
        } catch (error) {
          console.error('[guardian] escalation SMS failed', { familyId, callbackId, memberId: m.id, error });
        }
      }

      // Outbound call for critical emergencies
      if (severity === 'critical' && !signal?.aborted) {
        sendStarted = true;
        try {
          await initiateCall({ to: phone, twimlUrl, signal });
          result.call = true;
        } catch (error) {
          console.error('[guardian] escalation call failed', { familyId, callbackId, memberId: m.id, error });
        }
      }
      return result;
    }));
    for (const result of reached) {
      if (!result) continue;
      if (result.sms) smsSent = true;
      if (result.call) callAttempted = true;
      // Recorded only once a send to them actually succeeded: this column is
      // the record of who was told.
      if (result.sms || result.call) notifiedIds.push(result.id);
    }
  }
  const interrupted = signal?.aborted === true;

  // Record the escalation. A stable id, so a retry of an undelivered one
  // updates its row instead of filing a second.
  const { error: escalationError } = await supabase.from('guardian_escalations').upsert({
    id: stableId(callbackId, 'escalation'),
    family_id: familyId,
    communication_id: commId ?? null,
    escalation_type: escalationType,
    severity,
    description,
    caller_number: callerNumber ?? null,
    // NULL when there was nobody to text or call, [] when there was and nobody
    // was reached. The dashboard shows both as "no manager reached by phone";
    // the retry sweep (lib/guardian/escalation-retry.ts) re-attempts only the
    // second, since a phone that is not on file cannot be reached by trying
    // again. The column has no other writer, so the distinction holds.
    notified_member_ids: reachable ? notifiedIds : null,
    push_sent: pushSent,
    sms_sent: smsSent,
    call_attempted: callAttempted,
  }, { onConflict: 'id' });

  if (notifiedIds.length === 0 && !reachable && !escalationError) {
    // Nobody to tell: Twilio is not configured, or no active manager has a
    // phone on file. A retry would find the same, so this is not left for one:
    // the in-app notice and the dashboard row are what this family gets, the
    // claim is processed, and the callers complete. (Before this answer existed
    // the case was `undelivered`, and the SMS lane answered 503 for it on
    // every recovery tick until a phone was added.) With the record NOT landed as
    // well, it falls through to `record_failed` below: the same bounded answer.
    console.error('[guardian] escalation had nobody to text or call; recorded with nobody reached', {
      familyId, callbackId, pushSent, twilioReady, managers: managers.length,
    });
    await markGuardianCallbackProcessed(supabase, callbackId);
    return { kind: 'unreachable', pushSent, notifiedCount: 0 };
  }

  if (notifiedIds.length === 0 && reachable) {
    // The record is what the retry sweep reads. When it did not land the sweep
    // would never find this escalation, so leave the work item it lands the
    // record from instead (lib/guardian/escalation-owed.ts).
    const recorded = !escalationError;
    const owed = recorded ? false : await oweGuardianEscalation(supabase, body, { pushSent });
    if (interrupted && sendStarted) {
      // Cut off with a send in flight. That send may still have been accepted
      // by Twilio, so the claim is parked rather than given back: the ten
      // minutes before an `error` row can be reclaimed is what keeps the
      // caller's immediate retry from texting the same manager twice. The
      // record above says nobody was confirmed reached, and the sweep that
      // re-attempts such records runs on the recovery cron.
      console.error('[guardian] escalation interrupted before any manager was confirmed reached; holding the claim', {
        familyId, callbackId, pushSent, recorded, owed,
      });
      await markGuardianCallbackError(supabase, callbackId, 'Escalation interrupted before any manager was reached.');
      return { kind: 'interrupted', pushSent, notifiedCount: 0, recorded, owed };
    }
    // Nobody's phone was reached. Not a success: say so, and give the claim
    // back so the retry sweep (or a caller's retry) can try again. The
    // unacknowledged row stays at the top of the Guardian dashboard either way.
    console.error('[guardian] escalation reached no manager by SMS or call; leaving it retryable', {
      familyId, callbackId, pushSent, recorded, owed, interrupted,
    });
    await releaseGuardianCallback(supabase, 'emergency_escalation', callbackId);
    return interrupted
      ? { kind: 'interrupted', pushSent, notifiedCount: 0, recorded, owed }
      : { kind: 'undelivered', pushSent, notifiedCount: 0, recorded, owed };
  }

  if (escalationError) {
    // Deliberately `error`, not a release: the alerts above have gone out (or,
    // with nobody to text or call, the in-app notice has). When a manager was
    // texted or called the mark makes the claim final — no retry, however
    // late, texts and calls them again; with nobody reached by phone the
    // ten minutes before an `error` row can be reclaimed are enough.
    console.error('[guardian] escalation could not be recorded after alerts went out', { familyId, callbackId, notifiedCount: notifiedIds.length, error: escalationError });
    await markGuardianCallbackError(supabase, callbackId, notifiedIds.length > 0 ? ESCALATION_SENT_UNRECORDED : ESCALATION_UNREACHABLE_UNRECORDED);
    if (notifiedIds.length > 0) {
      // The final claim keeps every retry from re-sending; the record should
      // say so too. When this was the retry sweep's attempt the record it read
      // still says nobody was reached, so record who WAS told, narrowly, on the
      // row that is already there (a first attempt has none, and this updates
      // nothing). The sweep also leaves alone a record whose claim carries the
      // mark above, for when this write fails as well
      // (lib/guardian/escalation-retry.ts).
      const { error: toldError } = await supabase.from('guardian_escalations')
        .update({ notified_member_ids: notifiedIds, sms_sent: smsSent, call_attempted: callAttempted, push_sent: pushSent })
        .eq('id', stableId(callbackId, 'escalation')).eq('family_id', familyId)
        .select('id');
      if (toldError) console.error('[guardian] could not record which managers an unrecorded escalation reached', { familyId, callbackId, error: toldError });
    }
    return { kind: 'record_failed' };
  }

  await markGuardianCallbackProcessed(supabase, callbackId);
  return { kind: 'delivered', pushSent, smsSent, callAttempted, notifiedCount: notifiedIds.length };
}
