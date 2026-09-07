// The AI Front Desk, reading the tables telephony actually writes.
//
// This route used to render a module that read `call_logs` and
// `front_desk_settings` (0092) — a call log a human typed and a screening
// toggle no webhook ever consulted. The Contact Center (0214) files every real
// inbound call as a `voice` row in `family_inbox_messages` and keeps the
// family's number on `family_contact_channels`, so those are what this page
// reads. The old tables stay readable as history and are no longer written.
//
// Both reads fail closed and independently: one failing renders a notice on
// that section, both failing renders a retryable error. An empty list and a
// database that did not answer are different facts, and this page never lets
// the second look like the first.
import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ErrorState } from '@/components/ui/states';
import {
  FrontDeskModule, type FrontDeskChannel, type FrontDeskVoiceMessage,
} from '@/components/modules/front-desk-module';

export const metadata: Metadata = { title: 'AI Front Desk' };
export const dynamic = 'force-dynamic';

export default async function FrontDeskPage() {
  const t = await getTranslations();
  const ctx = await requireFeature('/dashboard/front-desk');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [voiceResult, channelResult] = await Promise.all([
    supabase
      .from('family_inbox_messages')
      .select('id, from_addr, body, ai_summary, ai_intent, ai_handled, status, occurred_at')
      .eq('family_id', familyId)
      .eq('channel', 'voice')
      .order('occurred_at', { ascending: false })
      .limit(100),
    supabase
      .from('family_contact_channels')
      .select('phone_number, email_local, provisioning_status, ai_concierge_enabled, forward_to_phone')
      .eq('family_id', familyId)
      .maybeSingle(),
  ]);

  if (voiceResult.error) console.error('[dashboard/front-desk] voice inbox read failed', voiceResult.error);
  if (channelResult.error) console.error('[dashboard/front-desk] contact channel read failed', channelResult.error);
  if (voiceResult.error && channelResult.error) {
    return <ErrorState message={t('frontDesk.couldNotLoadTheFrontDesk')} />;
  }

  return (
    <FrontDeskModule
      voice={(voiceResult.data ?? []) as FrontDeskVoiceMessage[]}
      channel={(channelResult.data ?? null) as FrontDeskChannel | null}
      unavailable={{ voice: Boolean(voiceResult.error), channel: Boolean(channelResult.error) }}
    />
  );
}
