import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getOrCreateChannel } from '@/lib/contact-center/server';
import { suggestEmailLocal } from '@/lib/contact-center/address';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import type { Tables } from '@/lib/database.types';
import { ContactCenterModule } from '@/components/modules/contact-center-module';

export const metadata: Metadata = { title: 'Family Operations Center' };
export const dynamic = 'force-dynamic';

// Family+ only. The central contact identity (@bubaly.com address + dedicated
// phone) plus the unified inbox everything the AI concierge handles routes into.
export default async function ContactCenterPage() {
  const ctx = await requirePlanLevel(2);
  const familyId = ctx.active.familyId;
  const admin = createServiceClient();

  const [channel, { data: messages }] = await Promise.all([
    getOrCreateChannel(admin, familyId),
    admin.from('family_inbox_messages')
      .select('id, channel, direction, from_addr, to_addr, subject, body, ai_summary, ai_intent, status, occurred_at')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(100),
  ]);

  return (
    <ContactCenterModule
      channel={channel}
      messages={(messages ?? []) as InboxRow[]}
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
