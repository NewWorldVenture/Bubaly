// app/api/guardian/inbound/whatsapp/route.ts
// Twilio webhook — handles inbound WhatsApp messages to a Bubaly Guardian number.
// Twilio delivers WhatsApp on the same Messages webhook with a `whatsapp:` prefix
// on From/To. Runs scam detection, logs the message, and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { detectScamWithAI } from '@/lib/guardian/scam-ai';
import { validateTwilioSignature, formatPhone } from '@/lib/guardian/twilio';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

/** Strip Twilio's `whatsapp:` channel prefix, leaving a bare E.164 number. */
function stripChannel(addr: string | null): string | null {
  if (!addr) return null;
  return addr.replace(/^whatsapp:/i, '');
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/guardian/inbound/whatsapp`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const from = stripChannel(params.From ?? null);
  const to = stripChannel(params.To ?? null);
  const body = params.Body ?? '';
  const smsSid = params.SmsSid ?? params.MessageSid ?? null;

  const supabase = createServiceClient();
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Find which family member this Guardian number belongs to.
  const { data: memberProfile } = await gFrom('guardian_member_profiles')
    .select('id, family_id, member_id, default_mode_suspected_spam, default_mode_blocked, default_mode_unknown')
    .eq('guardian_phone', to)
    .eq('is_active', true)
    .maybeSingle();

  if (!memberProfile) {
    return new NextResponse('', { status: 200 });
  }

  const familyId = (memberProfile as { family_id: string }).family_id;
  const memberId = (memberProfile as { member_id: string }).member_id;

  // Run decision pipeline.
  const decision = await runDecisionPipeline(supabase, {
    callerPhone: from,
    callerName: null,
    familyId,
    memberId,
    initialTranscript: body,
  });

  // Deep scam analysis on the message body.
  const scamResult = await detectScamWithAI(body, from, `Family ID: ${familyId}`);

  // Create communication record.
  const { data: comm } = await gFrom('guardian_communications').insert({
    family_id: familyId,
    member_id: memberId,
    contact_id: decision.contactId,
    comm_type: 'whatsapp_inbound',
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

  // Update contact last-contact timestamp.
  if (decision.contactId) {
    await gFrom('guardian_contacts')
      .update({ last_contact_at: new Date().toISOString() })
      .eq('id', decision.contactId);
  }

  // Blocked / high-confidence spam — silently discard.
  if (decision.routingMode === 'blocked' || (scamResult.isScam && scamResult.confidence >= 80)) {
    return new NextResponse('', { status: 200 });
  }

  // Notify the family member.
  const callerDisplay = decision.contactName ?? formatPhone(from);
  const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;

  try {
    await supabase.from('notifications').insert({
      family_id: familyId,
      user_id: null,
      type: 'system',
      title: `💚 WhatsApp from ${callerDisplay}`,
      body: preview,
      related_type: 'guardian_communications',
      related_id: comm?.id ?? null,
    });
  } catch { /* non-fatal */ }

  return new NextResponse('', { status: 200 });
}
