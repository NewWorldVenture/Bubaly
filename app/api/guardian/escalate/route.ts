// app/api/guardian/escalate/route.ts
// Emergency escalation endpoint — called when AI detects an emergency call.
// Notifies ALL parent members via push + SMS + attempted outbound call.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { sendSms, initiateCall, isTwilioConfigured } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export async function POST(req: NextRequest) {
  // Internal only — verify with shared secret
  const authHeader = req.headers.get('authorization');
  const secret = process.env.GUARDIAN_INTERNAL_SECRET;
  if (secret && authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    familyId: string;
    commId?: string;
    escalationType: string;
    severity: 'high' | 'critical';
    description: string;
    callerNumber?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { familyId, commId, escalationType, severity, description, callerNumber } = body;
  const supabase = createServiceClient();
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Get all parent/manager members with phone numbers
  const { data: members } = await supabase
    .from('family_members')
    .select('id, display_name, role')
    .eq('family_id', familyId)
    .eq('is_active', true);

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
    const { data: profiles } = await supabase.from('profiles').select('id, phone').in('id',
      (members as { id: string }[]).map(m => m.id)
    );
    const phoneMap = new Map((profiles ?? []).map((p: { id: string; phone?: string | null }) => [p.id, p.phone]));
    for (const member of members) {
      const m = member as { id: string; display_name: string; role: string };
      if (!['owner', 'manager', 'parent'].includes(m.role)) continue;
      const phone = phoneMap.get(m.id);
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
  await gFrom('guardian_escalations').insert({
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

  return NextResponse.json({ ok: true, pushSent, smsSent, callAttempted, notifiedCount: notifiedIds.length });
}
