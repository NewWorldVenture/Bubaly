import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { createServiceClient } from '@/lib/supabase/server';
import { getOrCreateChannelResult } from '@/lib/contact-center/server';
import { suggestEmailLocal } from '@/lib/contact-center/address';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import type { Tables } from '@/lib/database.types';
import { ContactCenterModule } from '@/components/modules/contact-center-module';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Family Operations Center' };
export const dynamic = 'force-dynamic';

// Family+ only. The central contact identity (@bubaly.com address + dedicated
// phone) plus the unified inbox everything the AI concierge handles routes into.
export default async function ContactCenterPage() {
  const t = await getTranslations();
  const ctx = await requirePlanLevel(2);
  const familyId = ctx.active.familyId;
  const admin = createServiceClient();

  const [channelResult, messagesResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(admin.from('family_inbox_messages')
      .select('id, channel, direction, from_addr, to_addr, subject, body, ai_summary, ai_intent, status, occurred_at')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(100)),
  ]);

  if (channelResult.error || messagesResult.error) {
    console.error('[contact-center] page data read failed', channelResult.error ?? messagesResult.error);
    return <ErrorState message={t('contactCenter.theContactCenterIsTemporarily')} />;
  }

  return (
    <ContactCenterModule
      channel={channelResult.data}
      messages={(messagesResult.data ?? []) as InboxRow[]}
      suggestedLocal={suggestEmailLocal(ctx.active.family.name)}
      twilioReady={isTwilioConfigured()}
      canManage={ctx.active.role === 'parent'}
    />
  );
}

export type InboxRow = Pick<
  Tables<'family_inbox_messages'>,
  'id' | 'channel' | 'direction' | 'from_addr' | 'to_addr' | 'subject' | 'body' | 'ai_summary' | 'ai_intent' | 'status' | 'occurred_at'
>;
