// app/api/guardian/inbound/sms/route.ts
// Twilio webhook — handles inbound SMS to a Bubaly Guardian number.
// Runs scam detection, logs the message, and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { detectScamWithAI } from '@/lib/guardian/scam-ai';
import { sendSms, validateTwilioSignature } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/guardian/inbound/sms`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const from = params.From ?? null;
  const to = params.To ?? null;
  const body = params.Body ?? '';
  const smsSid = params.SmsSid ?? params.MessageSid ?? null;

  if (!isValidGuardianEventId(smsSid) || body.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  const supabase = createServiceClient();
  const eventClaimed = await claimGuardianCallback(supabase, 'inbound_sms', smsSid);
  if (!eventClaimed) return new NextResponse('', { status: 200 });
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Find which family member this number belongs to
  const { data: memberProfile } = await gFrom('guardian_member_profiles')
    .select('id, family_id, member_id, default_mode_suspected_spam, default_mode_blocked, default_mode_unknown')
    .eq('guardian_phone', to)
    .eq('is_active', true)
    .maybeSingle();

  if (!memberProfile) {
    await markGuardianCallbackProcessed(supabase, smsSid);
    return new NextResponse('', { status: 200 });
  }

  const familyId = (memberProfile as { family_id: string }).family_id;
  const memberId = (memberProfile as { member_id: string }).member_id;

  // Run decision pipeline
  const decision = await runDecisionPipeline(supabase, {
    callerPhone: from,
    callerName: null,
    familyId,
    memberId,
    initialTranscript: body,
  });

  // Deep scam analysis on SMS body
  const scamResult = await detectScamWithAI(body, from, `Family ID: ${familyId}`);

  // Create communication record
  const { data: comm } = await gFrom('guardian_communications').insert({
    family_id: familyId,
    member_id: memberId,
    contact_id: decision.contactId,
    comm_type: 'sms_inbound',
    direction: 'inbound',
    from_number: from,
    to_number: to,
    from_name: decision.contactName,
    body,
    trust_level_at_time: decision.trustLevel,
    routing_mode_used: decision.routingMode,
    routing_rule_id: decision.ruleId,
    ai_decision_reason: decision.reason,
    scam_detected: scamResult.isScam,
    scam_type: scamResult.scamType,
    scam_confidence: scamResult.confidence,
    twilio_sms_sid: smsSid,
    status: scamResult.isScam && scamResult.confidence >= 80 ? 'blocked' : 'received',
  }).select('id').single();

  // Update contact last contact timestamp
  if (decision.contactId) {
    await gFrom('guardian_contacts')
      .update({ last_contact_at: new Date().toISOString() })
      .eq('id', decision.contactId);
  }

  // For blocked/spam — silently discard (don't auto-reply)
  if (decision.routingMode === 'blocked' || (scamResult.isScam && scamResult.confidence >= 80)) {
    await markGuardianCallbackProcessed(supabase, smsSid);
    return new NextResponse('', { status: 200 });
  }

  // Notify the family member
  const callerDisplay = decision.contactName ?? formatPhone(from);
  const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;

  try {
    // Through notify() rather than a raw insert, so a routine screened text
    // obeys the family's quiet hours. This row fires for EVERY message that is
    // not blocked or spam — it is the most frequent notification the product
    // writes, and a raw insert made it the one most likely to wake a house at
    // two in the morning. Not `urgent`: a text from the dentist can wait until
    // the window ends. A genuine emergency comes through /api/guardian/escalate,
    // which is marked urgent and still lands immediately.
    const scope = await systemScopeForFamily(supabase, familyId);
    if (scope) {
      await notify(scope, {
        recipients: 'family',
        type: 'system',
        title: `💬 Text from ${callerDisplay}`,
        body: preview,
        relatedType: 'guardian_communications',
        relatedId: comm?.id ?? null,
      });
    }
  } catch { /* non-fatal */ }

  // Suggest trust upgrade if this is a repeated unknown contact
  if (decision.trustLevel === 'unknown' && from) {
    const { count } = await gFrom('guardian_communications')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('from_number', from);

    if ((count ?? 0) >= 3) {
      const existing = await gFrom('guardian_suggestions')
        .select('id')
        .eq('family_id', familyId)
        .eq('suggestion_type', 'update_trust')
        .maybeSingle();

      if (!existing.data) {
        await gFrom('guardian_suggestions').insert({
          family_id: familyId,
          suggestion_type: 'update_trust',
          title: `Add ${formatPhone(from)} to your contacts?`,
          reasoning: `${formatPhone(from)} has contacted you ${(count ?? 0) + 1} times but isn't in your trust graph. Adding them would let you customize how Bubaly handles their messages.`,
          evidence: { phone: from, message_count: (count ?? 0) + 1 },
          proposed_trust_level: 'known_contact',
        });
      }
    }
  }

  await markGuardianCallbackProcessed(supabase, smsSid);
  return new NextResponse('', { status: 200 });
}
