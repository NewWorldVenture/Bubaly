import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import {
  isTwilioConfigured, searchAvailableNumber, provisionNumber,
} from '@/lib/guardian/twilio';
import { classifyIntent, summarizeInbound, shouldNotifyFamily, type InboundChannel } from './routing';

type Admin = ReturnType<typeof createServiceClient>;
export type ContactChannel = Tables<'family_contact_channels'>;
type ContactCenterError = { message: string; code?: string };

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
}

/** Read a family's contact channel, creating the empty row on first access. */
export async function getOrCreateChannelResult(admin: Admin, familyId: string): Promise<{
  data: ContactChannel | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin.from('family_contact_channels').select('*').eq('family_id', familyId).maybeSingle();
  if (error) return { data: null, error };
  if (data) return { data: data as ContactChannel, error: null };
  const created = await admin
    .from('family_contact_channels')
    .upsert({ family_id: familyId }, { onConflict: 'family_id' })
    .select('*')
    .maybeSingle();
  return { data: (created.data ?? null) as ContactChannel | null, error: created.error };
}

export async function getOrCreateChannel(admin: Admin, familyId: string): Promise<ContactChannel | null> {
  const result = await getOrCreateChannelResult(admin, familyId);
  if (result.error) console.error('[contact-center] channel read/create failed', result.error);
  return result.data;
}

/** Resolve the family that owns a dedicated inbound number (webhook routing). */
export async function resolveFamilyByNumberResult(admin: Admin, toNumber: string): Promise<{
  familyId: string | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin
    .from('family_contact_channels')
    .select('family_id')
    .eq('phone_number', toNumber)
    .maybeSingle();
  return { familyId: data?.family_id ?? null, error };
}

export async function resolveFamilyByNumber(admin: Admin, toNumber: string): Promise<string | null> {
  const result = await resolveFamilyByNumberResult(admin, toNumber);
  if (result.error) console.error('[contact-center] phone routing read failed', result.error);
  return result.familyId;
}

/** Resolve the family that owns a bubaly.com local-part (inbound email routing). */
export async function resolveFamilyByEmailLocalResult(admin: Admin, local: string): Promise<{
  familyId: string | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin
    .from('family_contact_channels')
    .select('family_id')
    .ilike('email_local', local)
    .maybeSingle();
  return { familyId: data?.family_id ?? null, error };
}

export async function resolveFamilyByEmailLocal(admin: Admin, local: string): Promise<string | null> {
  const result = await resolveFamilyByEmailLocalResult(admin, local);
  if (result.error) console.error('[contact-center] email routing read failed', result.error);
  return result.familyId;
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
  const channel = await getOrCreateChannelResult(admin, familyId);
  if (channel.error) return { ok: false, skipped: false, error: 'Could not load the family contact channel.' };
  if (!isTwilioConfigured()) {
    const { error } = await admin.from('family_contact_channels').update({ provisioning_status: 'pending' }).eq('family_id', familyId);
    if (error) return { ok: false, skipped: false, error: 'Could not save the phone request.' };
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
    const { error } = await admin.from('family_contact_channels').update({
      phone_number: provisioned.phoneNumber,
      phone_number_sid: provisioned.sid,
      provisioning_status: 'active',
    }).eq('family_id', familyId);
    if (error) return { ok: false, skipped: false, error: 'The number was provisioned but could not be saved. Please contact support.' };
    return { ok: true, phoneNumber: provisioned.phoneNumber };
  } catch (e) {
    const { error: statusError } = await admin.from('family_contact_channels').update({ provisioning_status: 'failed' }).eq('family_id', familyId);
    if (statusError) console.error('[contact-center] failed to save provisioning failure status', statusError);
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

  const { error } = await admin.from('family_inbox_messages').upsert({
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
  if (error) {
    console.error('[contact-center] inbound message persistence failed', error);
    throw new Error('Inbound message persistence failed');
  }

  // The caller (webhook) decides how to escalate (SMS the human fallback, etc.)
  // using the returned flag — this lib stays storage-only.
  return { intent, escalated: escalate };
}

/** Record an outbound message the concierge sent (auto-reply), for the timeline. */
export async function recordOutboundMessage(admin: Admin, input: {
  familyId: string; channel: InboundChannel; to?: string; body: string;
}): Promise<void> {
  const { error } = await admin.from('family_inbox_messages').insert({
    family_id: input.familyId,
    channel: input.channel,
    direction: 'outbound',
    to_addr: input.to ?? null,
    body: input.body,
    ai_handled: true,
    status: 'read',
  });
  if (error) {
    console.error('[contact-center] outbound message persistence failed', error);
    throw new Error('Outbound message persistence failed');
  }
}
