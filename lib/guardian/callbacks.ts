import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_EVENT_ID_LENGTH = 160;
const STALE_CLAIM_MS = 10 * 60 * 1000;

type CallbackClient = SupabaseClient;

/** Reject malformed provider identifiers before they become database keys. */
export function isValidGuardianEventId(value: string | null | undefined): value is string {
  return !!value && value.length <= MAX_EVENT_ID_LENGTH && /^[A-Za-z0-9:_-]+$/.test(value);
}

/** Keep webhook bodies and provider fields bounded before downstream work. */
export function isTwilioBodyTooLarge(req: Request, maxBytes = 64 * 1024): boolean {
  const rawLength = req.headers.get('content-length');
  if (!rawLength) return false;
  const length = Number(rawLength);
  return Number.isFinite(length) && length > maxBytes;
}

/**
 * Atomically claim a Twilio callback. A retry of an active or completed claim
 * is a no-op; claims abandoned by a crashed worker can be reclaimed later.
 */
export async function claimGuardianCallback(
  client: CallbackClient,
  callbackType: string,
  eventId: string,
): Promise<boolean> {
  if (!isValidGuardianEventId(eventId) || !callbackType || callbackType.length > 80) return false;

  const { error } = await client.from('guardian_callback_events').insert({
    event_id: eventId,
    callback_type: callbackType,
  });
  if (!error) return true;
  if (error.code !== '23505') return false;

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data } = await client
    .from('guardian_callback_events')
    .update({ received_at: new Date().toISOString(), status: 'processing', error: null })
    .eq('event_id', eventId)
    .in('status', ['processing', 'error'])
    .lt('received_at', cutoff)
    .select('event_id')
    .maybeSingle();
  return !!data;
}

export async function markGuardianCallbackProcessed(client: CallbackClient, eventId: string): Promise<void> {
  await client.from('guardian_callback_events').update({
    status: 'processed',
    processed_at: new Date().toISOString(),
  }).eq('event_id', eventId);
}

export async function markGuardianCallbackError(client: CallbackClient, eventId: string, error: string): Promise<void> {
  await client.from('guardian_callback_events').update({
    status: 'error',
    error: error.slice(0, 500),
  }).eq('event_id', eventId);
}
