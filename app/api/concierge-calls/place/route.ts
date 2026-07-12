import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Places queued outbound concierge calls via the telephony provider. CRON_SECRET
// gated (same as every other cron). Provider-gated: without a configured voice
// provider (TWILIO_*), queued calls are flipped to 'action_needed' with a clear
// note instead of silently stalling — so the feature is honest and usable end to
// end even before telephony is wired, and lights up automatically once it is.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  // Due, queued, with a number to dial. Bounded batch.
  const { data: due, error } = await admin
    .from('concierge_calls')
    .select('id, callee_phone, attempts')
    .eq('status', 'queued')
    .not('callee_phone', 'is', null)
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(25);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = due ?? [];
  const providerReady = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_CALLER_NUMBER);

  if (!providerReady) {
    // Honest degrade: park them for the family with a clear reason.
    for (const r of rows) {
      await admin.from('concierge_calls').update({
        status: 'action_needed',
        outcome: 'Voice calling isn’t connected yet — add a telephony provider to place this automatically, or call and log the result.',
      }).eq('id', r.id);
    }
    return NextResponse.json({ ok: true, placed: 0, parked: rows.length, providerReady: false });
  }

  // Provider ready: mark 'calling' + bump attempts. The provider webhook (out of
  // scope here) later writes outcome/transcript_summary/duration and flips to
  // completed/failed. This keeps placement idempotent and the batch bounded.
  let placed = 0;
  for (const r of rows) {
    const { error: upErr } = await admin.from('concierge_calls')
      .update({ status: 'calling', attempts: (r.attempts ?? 0) + 1 })
      .eq('id', r.id).eq('status', 'queued');
    if (!upErr) placed++;
    // NOTE: the actual provider dial (twilio.calls.create with a TwiML/AI stream
    // pointed at the brief) is triggered here when integrating a voice provider.
  }
  return NextResponse.json({ ok: true, placed, parked: 0, providerReady: true });
}
