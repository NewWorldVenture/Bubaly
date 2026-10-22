import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { FAMILY_EMAIL_MIN_PLAN_LEVEL } from '@/lib/constants/plans';
import { settle } from '@/lib/supabase/settle';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { isManager } from '@/lib/constants/roles';
import { getOrCreateChannelResult } from '@/lib/contact-center/server';
import { readSmsReplyStatuses } from '@/lib/contact-center/sms-reply-status';
import { suggestEmailLocal } from '@/lib/contact-center/address';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import type { Tables } from '@/lib/database.types';
import { ContactCenterModule } from '@/components/modules/contact-center-module';
import { ErrorState } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.familyOperationsCenter') };
}
export const dynamic = 'force-dynamic';

// Family+ only. The central contact identity (@bubaly.com address + dedicated
// phone) plus the unified inbox everything the AI concierge handles routes into.
export default async function ContactCenterPage() {
  const t = await getTranslations();
  const ctx = await requirePlanLevel(FAMILY_EMAIL_MIN_PLAN_LEVEL);
  // This page shows the household inbox — every email, text and voicemail
  // transcript — which the owner's ROLE-SCOPE-001 decision withholds from a
  // guest. /dashboard/inbox already sent a guest away; this route, one over,
  // read the same rows and rendered them. A guest goes to their landing page.
  refuseGuest(ctx, '/dashboard/contact-center');
  const familyId = ctx.active.familyId;
  // The service role is for the channel row only (provisioning creates it when
  // missing). The messages are read as the CALLER, so the database's own rule
  // for who reads the inbox (0214, and the reserved 0509 once it lands) is the
  // one this page obeys, rather than a service-role read that answers to none.
  const admin = createServiceClient();
  const supabase = await createServer();

  const [channelResult, messagesResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(supabase.from('family_inbox_messages')
      .select('id, channel, direction, from_addr, to_addr, subject, body, ai_summary, ai_intent, status, occurred_at')
      .eq('family_id', familyId)
      .order('occurred_at', { ascending: false })
      .limit(100)),
  ]);

  if (channelResult.error || messagesResult.error) {
    console.error('[contact-center] page data read failed', channelResult.error ?? messagesResult.error);
    return <ErrorState message={t('contactCenter.theContactCenterIsTemporarily')} />;
  }

  const messages = (messagesResult.data ?? []) as InboxRow[];
  const smsReplyStatuses = await readSmsReplyStatuses(messages);

  return (
    <ContactCenterModule
      channel={channelResult.data}
      messages={messages}
      smsReplyStatuses={smsReplyStatuses}
      suggestedLocal={suggestEmailLocal(ctx.active.family.name)}
      twilioReady={isTwilioConfigured()}
      canManage={ctx.active.role === 'parent'}
      canFile={isManager(ctx.active.role)}
    />
  );
}

export type InboxRow = Pick<
  Tables<'family_inbox_messages'>,
  'id' | 'channel' | 'direction' | 'from_addr' | 'to_addr' | 'subject' | 'body' | 'ai_summary' | 'ai_intent' | 'status' | 'occurred_at'
>;
