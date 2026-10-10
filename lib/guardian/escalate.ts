// lib/guardian/escalate.ts
// The emergency escalation itself, shared by the internal /api/guardian/escalate
// route and by the inbound SMS, WhatsApp and screening flows that detect an
// emergency. Before this lived only in the route, and nothing called the route,
// so a detected emergency never texted or called a manager.
//
// Notifies every manager (parent + adult) via push + SMS + attempted outbound call.

import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSms, initiateCall, isTwilioConfigured } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { claimGuardianCallback, markGuardianCallbackError, markGuardianCallbackProcessed, releaseGuardianCallback } from '@/lib/guardian/callbacks';
import { guardianEscalationEventId, type GuardianEscalationInput } from '@/lib/guardian/escalation';
import { appBaseUrl } from '@/lib/server/app-url';
import { isManager } from '@/lib/constants/roles';

export type GuardianEscalationOutcome =
  /** The claim could not be written; nothing was read or sent. */
  | { kind: 'claim_unavailable' }
  /** Another worker holds it, or it was already processed. */
  | { kind: 'duplicate' }
  /** A read the alert depends on failed before anything was sent; the claim was given back. */
  | { kind: 'read_failed' }
  /** Alerts went out but the escalation row could not be written; the claim is parked as `error`. */
  | { kind: 'record_failed' }
  /**
   * No manager was reached by SMS or call (no manager phone, Twilio not
   * configured, or every send failed). Recorded, and the claim given back so a
   * retry can try again: nothing reached a phone, so a retry cannot text twice.
   */
  | { kind: 'undelivered'; pushSent: boolean; notifiedCount: 0 }
  /**
   * The caller's deadline passed (or it cancelled) before any manager was
   * confirmed reached, and no further send was started once it had. Recorded
   * with nobody notified, so the undelivered-escalation sweep picks it up. A
   * send that was in flight was aborted on OUR side, which is not proof Twilio
   * refused it, so when a send had started the claim is parked as `error`
   * rather than given back: a retry inside ten minutes is a duplicate, and
   * after that it re-sends. When no send had started the claim is given back.
   */
  | { kind: 'interrupted'; pushSent: boolean; notifiedCount: 0 }
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
};

/** A stable UUID derived from the escalation's ledger id, so a retry writes the same rows. */
function stableId(callbackId: string, purpose: string): string {
  const hex = createHash('sha256').update(`${callbackId}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Reached = { id: string; sms: boolean; call: boolean };

export async function escalateGuardianEmergency(
  supabase: SupabaseClient,
  body: GuardianEscalationInput,
  options: GuardianEscalationOptions = {},
): Promise<GuardianEscalationOutcome> {
  const { familyId, commId, escalationType, severity, description, callerNumber } = body;
  const { signal } = options;
  const callbackId = guardianEscalationEventId(body);
  const claim = await claimGuardianCallback(supabase, 'emergency_escalation', callbackId);
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
  // Set the moment the first Twilio request is started. After that an abort
  // is not proof that nothing reached a phone (see `interrupted`).
  let sendStarted = false;
  if (twilioReady && members?.length) {
    const BASE_URL = appBaseUrl();
    const smsText = `[Bubaly Emergency Alert]\n${alertTitle}\n${alertBody}\nReply STOP to opt out.`;
    const twimlUrl = `${BASE_URL}/api/guardian/escalate/twiml?family=${familyId}&msg=${encodeURIComponent(description.slice(0, 200))}`;
    // The manager pair this product actually has. `public.member_role` is
    // ('parent','adult','teen','child','caregiver','guest') — the list here
    // used to read ['owner', 'manager', 'parent'], and two of those three
    // match nobody, so an adult co-parent was never texted or called.
    const managers = (members as Array<{ id: string; user_id: string | null; display_name: string; role: string }>).filter((m) => isManager(m.role));
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
    notified_member_ids: notifiedIds,
    push_sent: pushSent,
    sms_sent: smsSent,
    call_attempted: callAttempted,
  }, { onConflict: 'id' });

  if (notifiedIds.length === 0) {
    if (interrupted && sendStarted) {
      // Cut off with a send in flight. That send may still have been accepted
      // by Twilio, so the claim is parked rather than given back: the ten
      // minutes before an `error` row can be reclaimed is what keeps the
      // caller's immediate retry from texting the same manager twice. The
      // record above says nobody was confirmed reached, and the sweep that
      // re-attempts such records runs on the recovery cron.
      console.error('[guardian] escalation interrupted before any manager was confirmed reached; holding the claim', {
        familyId, callbackId, pushSent, recorded: !escalationError,
      });
      await markGuardianCallbackError(supabase, callbackId, 'Escalation interrupted before any manager was reached.');
      return { kind: 'interrupted', pushSent, notifiedCount: 0 };
    }
    // Nobody's phone was reached. Not a success: say so, and give the claim
    // back so the caller can retry. The unacknowledged row stays at the top of
    // the Guardian dashboard either way.
    console.error('[guardian] escalation reached no manager by SMS or call; leaving it retryable', {
      familyId, callbackId, pushSent, recorded: !escalationError, interrupted,
    });
    await releaseGuardianCallback(supabase, 'emergency_escalation', callbackId);
    return interrupted ? { kind: 'interrupted', pushSent, notifiedCount: 0 } : { kind: 'undelivered', pushSent, notifiedCount: 0 };
  }

  if (escalationError) {
    // Deliberately `error`, not a release: the alerts above have gone out, and
    // the ten minutes before an `error` row can be reclaimed is what keeps an
    // immediate retry from texting and calling every manager a second time.
    console.error('[guardian] escalation could not be recorded after alerts went out', { familyId, callbackId, error: escalationError });
    await markGuardianCallbackError(supabase, callbackId, 'Unable to record escalation.');
    return { kind: 'record_failed' };
  }

  await markGuardianCallbackProcessed(supabase, callbackId);
  return { kind: 'delivered', pushSent, smsSent, callAttempted, notifiedCount: notifiedIds.length };
}
