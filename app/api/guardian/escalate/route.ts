// app/api/guardian/escalate/route.ts
// Emergency escalation endpoint — called when AI detects an emergency call.
// Notifies ALL parent members via push + SMS + attempted outbound call.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { sendSms, initiateCall, isTwilioConfigured } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { claimGuardianCallback, markGuardianCallbackError, markGuardianCallbackProcessed } from '@/lib/guardian/callbacks';
import { guardianEscalationEventId, guardianEscalationSchema } from '@/lib/guardian/escalation';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export async function POST(req: NextRequest) {
  // Internal only — verify with shared secret. Fail CLOSED: this endpoint can
  // blast SMS + outbound calls to every parent, so an unset secret must mean
  // "disabled", never "open". (CRON_SECRET is the deploy-wide fallback.)
  const authHeader = req.headers.get('authorization');
  const secret = process.env.GUARDIAN_INTERNAL_SECRET || process.env.CRON_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid JSON' }, { status: 400 });
  const parsed = guardianEscalationSchema.safeParse(boundedBody.value);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid escalation payload' }, { status: 400 });
  const body = parsed.data;

  const { familyId, commId, escalationType, severity, description, callerNumber } = body;
  const supabase = createServiceClient();
  const callbackId = guardianEscalationEventId(body);
  const claimed = await claimGuardianCallback(supabase, 'emergency_escalation', callbackId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });
  const finish = async (payload: Record<string, unknown>, status = 200) => {
    await markGuardianCallbackProcessed(supabase, callbackId);
    return NextResponse.json(payload, { status });
  };
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Get all parent/manager members with phone numbers
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, user_id, display_name, role')
    .eq('family_id', familyId)
    .eq('is_active', true);
  if (membersError) {
    await markGuardianCallbackError(supabase, callbackId, 'Unable to load family members for escalation.');
    return NextResponse.json({ error: 'Unable to process escalation' }, { status: 500 });
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

  // Push notifications for all parents
  try {
    await supabase.from('notifications').insert({
      family_id: familyId,
      user_id: null,
      type: 'system',
      title: alertTitle,
      body: alertBody,
      related_type: commId ? 'guardian_communications' : undefined,
      related_id: commId ?? null,
    });
    pushSent = true;
  } catch { /* non-fatal */ }

  if (isTwilioConfigured() && members?.length) {
    // Get phones from profiles table where it's stored
    const userIds = (members as { user_id: string | null }[])
      .map((member) => member.user_id)
      .filter((id): id is string => !!id);
    const { data: profiles } = userIds.length > 0
      ? await supabase.from('profiles').select('id, phone').in('id', userIds)
      : { data: [] as { id: string; phone: string | null }[] };
    const phoneMap = new Map((profiles ?? []).map((p: { id: string; phone?: string | null }) => [p.id, p.phone]));
    for (const member of members) {
      const m = member as { id: string; user_id: string | null; display_name: string; role: string };
      if (!['owner', 'manager', 'parent'].includes(m.role)) continue;
      const phone = m.user_id ? phoneMap.get(m.user_id) : null;
      if (!phone) continue;
      notifiedIds.push(m.id);

      // SMS
      try {
        const smsText = `[Bubaly Emergency Alert]\n${alertTitle}\n${alertBody}\nReply STOP to opt out.`;
        await sendSms(phone, smsText);
        smsSent = true;
      } catch { /* non-fatal */ }

      // Outbound call for critical emergencies
      if (severity === 'critical') {
        try {
          const twimlUrl = `${BASE_URL}/api/guardian/escalate/twiml?family=${familyId}&msg=${encodeURIComponent(description.slice(0, 200))}`;
          await initiateCall({ to: phone, twimlUrl });
          callAttempted = true;
        } catch { /* non-fatal */ }
      }
    }
  }

  // Record the escalation
  const { error: escalationError } = await gFrom('guardian_escalations').insert({
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
  });
  if (escalationError) {
    await markGuardianCallbackError(supabase, callbackId, 'Unable to record escalation.');
    return NextResponse.json({ error: 'Unable to process escalation' }, { status: 500 });
  }

  return finish({ ok: true, pushSent, smsSent, callAttempted, notifiedCount: notifiedIds.length });
}
