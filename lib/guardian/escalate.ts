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
  | { kind: 'delivered'; pushSent: boolean; smsSent: boolean; callAttempted: boolean; notifiedCount: number };

/** A stable UUID derived from the escalation's ledger id, so a retry writes the same rows. */
function stableId(callbackId: string, purpose: string): string {
  const hex = createHash('sha256').update(`${callbackId}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function escalateGuardianEmergency(
  supabase: SupabaseClient,
  body: GuardianEscalationInput,
): Promise<GuardianEscalationOutcome> {
  const { familyId, commId, escalationType, severity, description, callerNumber } = body;
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
  if (twilioReady && members?.length) {
    const BASE_URL = appBaseUrl();
    for (const member of members) {
      const m = member as { id: string; user_id: string | null; display_name: string; role: string };
      // The manager pair this product actually has. `public.member_role` is
      // ('parent','adult','teen','child','caregiver','guest') — the list here
      // used to read ['owner', 'manager', 'parent'], and two of those three
      // match nobody, so an adult co-parent was never texted or called.
      if (!isManager(m.role)) continue;
      const phone = m.user_id ? phoneMap.get(m.user_id) : null;
      if (!phone) {
        console.error('[guardian] escalation cannot reach a manager with no phone on file', { familyId, callbackId, memberId: m.id });
        continue;
      }
      let reached = false;

      // SMS
      try {
        const smsText = `[Bubaly Emergency Alert]\n${alertTitle}\n${alertBody}\nReply STOP to opt out.`;
        await sendSms(phone, smsText);
        smsSent = true;
        reached = true;
      } catch (error) {
        console.error('[guardian] escalation SMS failed', { familyId, callbackId, memberId: m.id, error });
      }

      // Outbound call for critical emergencies
      if (severity === 'critical') {
        try {
          const twimlUrl = `${BASE_URL}/api/guardian/escalate/twiml?family=${familyId}&msg=${encodeURIComponent(description.slice(0, 200))}`;
          await initiateCall({ to: phone, twimlUrl });
          callAttempted = true;
          reached = true;
        } catch (error) {
          console.error('[guardian] escalation call failed', { familyId, callbackId, memberId: m.id, error });
        }
      }
      // Recorded only once a send to them actually succeeded: this column is
      // the record of who was told.
      if (reached) notifiedIds.push(m.id);
    }
  }

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
    // Nobody's phone was reached. Not a success: say so, and give the claim
    // back so the caller can retry. The unacknowledged row stays at the top of
    // the Guardian dashboard either way.
    console.error('[guardian] escalation reached no manager by SMS or call; leaving it retryable', {
      familyId, callbackId, pushSent, recorded: !escalationError,
    });
    await releaseGuardianCallback(supabase, 'emergency_escalation', callbackId);
    return { kind: 'undelivered', pushSent, notifiedCount: 0 };
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
