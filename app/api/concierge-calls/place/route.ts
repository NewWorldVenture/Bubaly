import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { NO_PROVIDER_OUTCOME } from '@/lib/concierge-calls/brief';

export const runtime = 'nodejs';
export const maxDuration = 60;

// The outbound concierge call queue. CRON_SECRET gated (same as every other
// cron).
//
// HONESTY BOUNDARY. Bubaly has no outbound voice integration: nothing here can
// dial, so nothing here may write `status = 'calling'`. An earlier version
// flipped due rows to 'calling' whenever TWILIO_* keys were present and left a
// note that the dial "is triggered here when integrating a voice provider" —
// which persisted a row that said a call was in progress while no phone rang.
// Now a due, queued call is parked as 'action_needed' with the reason written
// to `outcome`, so the row itself says a person places it. When a provider is
// integrated, the update that sets 'calling' must carry the provider's call id
// in `provider_ref` in the same write; `callDisplayState()` in
// lib/concierge-calls/brief.ts will only ever say "Calling…" for such a row,
// and tests/concierge-calls-honesty.test.ts pins both halves.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('place.unauthorized') }, { status: 401 });
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
  if (error) {
    console.error('[concierge-calls/place] queue read failed', error);
    return NextResponse.json({ ok: false, error: t('place.couldNotLoadQueuedConcierge') }, { status: 500 });
  }

  const rows = due ?? [];
  let parked = 0;
  for (const r of rows) {
    // Guarded on status so a row a person already acted on is not overwritten.
    const { error: upErr } = await admin.from('concierge_calls')
      .update({ status: 'action_needed', outcome: NO_PROVIDER_OUTCOME })
      .eq('id', r.id).eq('status', 'queued');
    if (upErr) {
      console.error('[concierge-calls/place] park write failed', upErr);
      continue;
    }
    parked++;
  }
  return NextResponse.json({ ok: true, placed: 0, parked, providerReady: false });
}
