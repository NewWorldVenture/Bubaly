// app/api/guardian/status/voicemail/route.ts
// Twilio callback after a voicemail recording completes.
// Updates the communication record and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { formatPhone, wrapTwiml, twimlSay, twimlHangup } from '@/lib/guardian/twilio';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const commId = searchParams.get('commId') ?? '';

  const formData = await req.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  const recordingUrl = params.RecordingUrl ?? null;
  const recordingDuration = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : null;
  const transcriptionText = params.TranscriptionText ?? null;

  if (!commId) {
    return new NextResponse(wrapTwiml(twimlSay('Thank you. Goodbye.'), twimlHangup()), {
      headers: { 'content-type': 'application/xml' },
    });
  }

  const supabase = createServiceClient();
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Fetch communication to get family context
  const { data: comm } = await gFrom('guardian_communications')
    .select('family_id, member_id, from_number, from_name')
    .eq('id', commId)
    .maybeSingle();

  if (comm) {
    const typedComm = comm as {
      family_id: string;
      member_id: string | null;
      from_number: string | null;
      from_name: string | null;
    };

    // Update the communication record with recording
    await gFrom('guardian_communications').update({
      status: 'handled',
      call_recording_url: recordingUrl,
      call_duration_secs: recordingDuration,
      body: transcriptionText,
      summary: transcriptionText
        ? `Voicemail from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}: "${transcriptionText.slice(0, 120)}"`
        : `Voicemail received from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}`,
      ended_at: new Date().toISOString(),
    }).eq('id', commId);

    // Notify family
    const callerDisplay = typedComm.from_name ?? formatPhone(typedComm.from_number);
    const bodyText = transcriptionText
      ? `"${transcriptionText.slice(0, 100)}${transcriptionText.length > 100 ? '…' : ''}"`
      : 'Tap to listen to the voicemail.';

    await supabase.from('notifications').insert({
      family_id: typedComm.family_id,
      user_id: null,
      type: 'system',
      title: `📩 Voicemail from ${callerDisplay}`,
      body: bodyText,
      related_type: 'guardian_communications',
      related_id: commId,
    });
  }

  return new NextResponse(
    wrapTwiml(twimlSay('Thank you for your message. Goodbye.'), twimlHangup()),
    { headers: { 'content-type': 'application/xml' } },
  );
}
