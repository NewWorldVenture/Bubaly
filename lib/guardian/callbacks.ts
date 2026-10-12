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
 * What happened when this worker tried to claim a callback.
 *
 * This used to be a boolean, and that single bit had to carry two answers that
 * call for opposite responses: "someone else has this" and "the claim could not
 * be written". Callers read the false as the first, answered the provider 200,
 * and Twilio does not retry a 200 — so a brief database outage silently threw
 * away emergency escalations, inbound messages and voicemail notifications. On
 * the voice and screening routes it also hung up on the caller while doing it.
 */
export type GuardianClaimOutcome =
  /** This worker owns the event and must process it. */
  | 'claimed'
  /** Another worker holds it, or it is already processed. Acknowledge. */
  | 'settled'
  /** The claim could not be read or written. Ask the provider to retry. */
  | 'unavailable';

export type GuardianClaimOptions = {
  /**
   * An `error` text that makes a claim final. A claim parked as `error` with
   * exactly this text is never reclaimed, however old: the caller parks it so
   * when its side effects went out and only their record failed, and a reclaim
   * would send them again. (The emergency escalation's mark; every other
   * `error` row is still reclaimable after ten minutes.) Written into a
   * PostgREST `or` filter, so it may not hold `,`, `(`, `)`, `"` or `\`.
   */
  finalError?: string;
};

/**
 * Atomically claim a Twilio callback. A retry of an active or completed claim
 * is a no-op; claims abandoned by a crashed worker can be reclaimed later.
 */
export async function claimGuardianCallback(
  client: CallbackClient,
  callbackType: string,
  eventId: string,
  options: GuardianClaimOptions = {},
): Promise<GuardianClaimOutcome> {
  const { finalError } = options;
  if (finalError !== undefined && !/^[^,()"\\]+$/.test(finalError)) throw new TypeError('A final claim error must be plain text a PostgREST filter can carry.');
  // A malformed id or callback type is unprocessable, and a retry cannot make
  // it well-formed. Settled rather than unavailable, so the provider stops.
  if (!isValidGuardianEventId(eventId) || !callbackType || callbackType.length > 80) return 'settled';

  const { error } = await client.from('guardian_callback_events').insert({
    event_id: eventId,
    callback_type: callbackType,
  });
  if (!error) return 'claimed';
  // Only a unique violation means someone got here first. Everything else —
  // storage down, permission denied, connection reset — is this worker failing
  // to ask the question, and must not be reported as somebody else's success.
  if (error.code !== '23505') return 'unavailable';

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  let reclaim = client
    .from('guardian_callback_events')
    .update({ received_at: new Date().toISOString(), status: 'processing', error: null })
    .eq('event_id', eventId)
    .in('status', ['processing', 'error'])
    .lt('received_at', cutoff);
  // A final claim is left where it is. Checked in the reclaim's own statement,
  // not in a read before it, so nothing can park it final in between. `is null`
  // as well: a held or abandoned claim has no error text, and `<>` alone reads
  // a NULL as not reclaimable.
  if (finalError !== undefined) reclaim = reclaim.or(`error.is.null,error.neq.${finalError}`);
  const { data, error: reclaimError } = await reclaim
    .select('event_id')
    .maybeSingle();
  // The same distinction one level down: this branch used to discard the error
  // and read a failed reclaim as "another worker holds it".
  if (reclaimError) return 'unavailable';
  return data ? 'claimed' : 'settled';
}

/**
 * Give a claim back after a failure that happened BEFORE any side effect, so
 * the retry the route is about to ask for can take it.
 *
 * The voice and WhatsApp routes answer 503 when the Guardian number cannot be
 * looked up or the decision pipeline fails, and each says in its own comment
 * that the event must stay unconsumed so Twilio retries it. The claim said
 * otherwise: it stayed `processing` with a fresh `received_at`, so the retry
 * hit the unique key, could not reclaim it for ten minutes, was 'settled', and
 * was acknowledged with nothing processed — the one answer that loses the
 * event. The SMS lane already makes a confirmed pre-completion failure
 * reclaimable at once (releaseGuardianSms); this is the same rule here.
 *
 * The row is deleted rather than marked `error`, because claimGuardianCallback
 * reclaims an `error` row only after the same ten minutes — the escalation
 * route records `error` after it has already sent messages, and that window
 * is what keeps a retry from sending them again. Only the row this worker
 * holds, still `processing` and of this callback type, is removed. Answers
 * whether it was, and says so on the console when it was not, because then the
 * next retry inside ten minutes will be acknowledged without being processed.
 */
export async function releaseGuardianCallback(
  client: CallbackClient,
  callbackType: string,
  eventId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('guardian_callback_events')
    .delete()
    .eq('event_id', eventId)
    .eq('callback_type', callbackType)
    .eq('status', 'processing')
    .select('event_id');
  if (error || !data || data.length === 0) {
    console.error(
      `[guardian-callbacks] could not release ${callbackType} ${eventId}; a retry inside ten minutes will be acknowledged without being processed`,
      error ?? 'no held row',
    );
    return false;
  }
  return true;
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
