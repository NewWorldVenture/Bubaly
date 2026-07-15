import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import {
  isTwilioConfigured, searchAvailableNumber, provisionNumber,
} from '@/lib/guardian/twilio';
import { classifyIntent, summarizeInbound, shouldNotifyFamily, type InboundChannel } from './routing';

type Admin = ReturnType<typeof createServiceClient>;
export type ContactChannel = Tables<'family_contact_channels'>;

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
}

/** Read a family's contact channel, creating the empty row on first access. */
export async function getOrCreateChannel(admin: Admin, familyId: string): Promise<ContactChannel | null> {
  const { data } = await admin.from('family_contact_channels').select('*').eq('family_id', familyId).maybeSingle();
  if (data) return data as ContactChannel;
  const { data: created } = await admin
    .from('family_contact_channels')
    .upsert({ family_id: familyId }, { onConflict: 'family_id' })
    .select('*')
    .maybeSingle();
  return (created ?? null) as ContactChannel | null;
}

/** Resolve the family that owns a dedicated inbound number (webhook routing). */
export async function resolveFamilyByNumber(admin: Admin, toNumber: string): Promise<string | null> {
  const { data } = await admin
    .from('family_contact_channels')
    .select('family_id')
    .eq('phone_number', toNumber)
    .maybeSingle();
  return data?.family_id ?? null;
}

/** Resolve the family that owns a bubaly.com local-part (inbound email routing). */
export async function resolveFamilyByEmailLocal(admin: Admin, local: string): Promise<string | null> {
  const { data } = await admin
    .from('family_contact_channels')
    .select('family_id')
    .ilike('email_local', local)
    .maybeSingle();
  return data?.family_id ?? null;
}

/**
 * Buy + wire a dedicated Twilio number for a family. Key-gated: with no Twilio
 * config it flips the row to `pending` (a human/owner provisions it) and returns
 * a skipped result — the rest of the Contact Center works without it. Never
 * throws; returns a discriminated result.
 */
export async function provisionFamilyNumber(
  admin: Admin, familyId: string, areaCode?: string,
): Promise<{ ok: true; phoneNumber: string } | { ok: false; skipped: boolean; error?: string }> {
  await getOrCreateChannel(admin, familyId);
  if (!isTwilioConfigured()) {
    await admin.from('family_contact_channels').update({ provisioning_status: 'pending' }).eq('family_id', familyId);
    return { ok: false, skipped: true };
  }
  try {
    const number = await searchAvailableNumber(areaCode);
    if (!number) return { ok: false, skipped: false, error: 'No numbers available for that area code.' };
    const provisioned = await provisionNumber({
      phoneNumber: number,
      voiceUrl: `${appUrl()}/api/contact-center/voice`,
      smsUrl: `${appUrl()}/api/contact-center/sms`,
      friendlyName: `Bubaly Family ${familyId.slice(0, 8)}`,
    });
    await admin.from('family_contact_channels').update({
      phone_number: provisioned.phoneNumber,
      phone_number_sid: provisioned.sid,
      provisioning_status: 'active',
    }).eq('family_id', familyId);
    return { ok: true, phoneNumber: provisioned.phoneNumber };
  } catch (e) {
    await admin.from('family_contact_channels').update({ provisioning_status: 'failed' }).eq('family_id', familyId);
    console.error('[contact-center] number provisioning failed', e);
    return { ok: false, skipped: false, error: 'Could not provision a number. Please try again.' };
  }
}

/**
 * File an inbound message into the family's unified inbox. Runs the deterministic
 * concierge classification, de-dupes on the provider ref, and pings the family
 * (best-effort) when the intent is urgent. Returns the classified intent.
 */
export async function recordInboundMessage(admin: Admin, input: {
  familyId: string; channel: InboundChannel; from?: string; to?: string;
  subject?: string; body: string; providerRef?: string; aiSummary?: string; aiIntent?: string;
}): Promise<{ intent: string; escalated: boolean }> {
  const intent = input.aiIntent ?? classifyIntent(input.body);
  const summary = input.aiSummary ?? summarizeInbound(input.body);
  const escalate = shouldNotifyFamily((intent as ReturnType<typeof classifyIntent>));

  await admin.from('family_inbox_messages').upsert({
    family_id: input.familyId,
    channel: input.channel,
    direction: 'inbound',
    from_addr: input.from ?? null,
    to_addr: input.to ?? null,
    subject: input.subject ?? null,
    body: input.body,
    ai_summary: summary,
    ai_intent: intent,
    provider_ref: input.providerRef ?? null,
  }, { onConflict: 'channel,provider_ref', ignoreDuplicates: true });

  // The caller (webhook) decides how to escalate (SMS the human fallback, etc.)
  // using the returned flag — this lib stays storage-only.
  return { intent, escalated: escalate };
}

/** Record an outbound message the concierge sent (auto-reply), for the timeline. */
export async function recordOutboundMessage(admin: Admin, input: {
  familyId: string; channel: InboundChannel; to?: string; body: string;
}): Promise<void> {
  await admin.from('family_inbox_messages').insert({
    family_id: input.familyId,
    channel: input.channel,
    direction: 'outbound',
    to_addr: input.to ?? null,
    body: input.body,
    ai_handled: true,
    status: 'read',
  });
}
