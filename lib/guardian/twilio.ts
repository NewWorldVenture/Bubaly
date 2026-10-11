// lib/guardian/twilio.ts — Twilio REST API helpers (no npm package, raw fetch).
// Covers: TwiML generation, call control, SMS, number provisioning.

import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';

function authHeader(): string {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${creds}`;
}

/**
 * One Twilio REST request. `signal` is the CALLER's deadline — a webhook's
 * request signal, or the step budget an inbound lane runs the escalation
 * under — and it is combined with this helper's own 15 s ceiling rather than
 * replacing it: fetchWithDeadline adds its timeout only when no signal is
 * given, so handing it the caller's signal alone would have removed the
 * per-request ceiling. Without a caller signal the ceiling stands on its own,
 * as before. (The escalation used to reach this with no signal at all, so a
 * caller that had timed out and moved on left every remaining send running.)
 */
async function twilioFetch(path: string, body?: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`;
  const res = await fetchWithDeadline(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: authHeader(),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : undefined,
  }, 15_000);
  if (!res.ok) {
    const bounded = await readBoundedResponseText(res, 64 * 1024);
    const text = bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]';
    throw new Error(`Twilio ${res.status}: ${text.slice(0, 200)}`);
  }
  return readBoundedResponseJson<unknown>(res, 256 * 1024);
}

/** True if Twilio is configured in this environment. */
export function isTwilioConfigured(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

// ─── TwiML Builders ────────────────────────────────────────────────────────

// Every value below is interpolated into an XML document Twilio parses
// strictly. A bare `&` in a URL (`?sessionId=…&turn=2`) is not well-formed XML
// and Twilio refuses the whole response (error 12100), so the call hears
// "an application error has occurred" instead of the prompt. And a value a
// customer typed (a forwarding number) that is not escaped can close the
// element and add verbs of its own. Escape text and attribute values alike.
function xml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** TwiML: say text via TTS. */
export function twimlSay(text: string, voice = 'Polly.Joanna-Neural'): string {
  return `<Say voice="${xml(voice)}">${xml(text)}</Say>`;
}

/** TwiML: Gather speech input from caller. */
export function twimlGather(opts: {
  action: string;           // URL Twilio will POST to with caller's speech
  text: string;             // prompt to speak
  timeout?: number;         // seconds to wait for speech (default 5)
  speechTimeout?: string;   // 'auto' or number
  voice?: string;
}): string {
  const { action, text, timeout = 5, speechTimeout = 'auto', voice = 'Polly.Joanna-Neural' } = opts;
  return `<Gather input="speech" action="${xml(action)}" timeout="${xml(timeout)}" speechTimeout="${xml(speechTimeout)}">
  <Say voice="${xml(voice)}">${xml(text)}</Say>
</Gather>`;
}

/** TwiML: record a voicemail. `action` redirects after recording; omit it to let
 *  the call continue to the next verbs. `transcribeCallback` receives the async
 *  transcription (the `action` POST fires before the transcript is ready). */
export function twimlRecord(opts: {
  action?: string; transcribeCallback?: string; maxLength?: number; text: string; voice?: string;
}): string {
  const { action, transcribeCallback, maxLength = 120, text, voice = 'Polly.Joanna-Neural' } = opts;
  const attrs = [
    action ? `action="${xml(action)}"` : '',
    `maxLength="${xml(maxLength)}"`,
    transcribeCallback ? `transcribe="true" transcribeCallback="${xml(transcribeCallback)}"` : '',
  ].filter(Boolean).join(' ');
  return `<Say voice="${xml(voice)}">${xml(text)}</Say>
<Record ${attrs} />`;
}

/**
 * TwiML: transfer to a phone number.
 *
 * Both values are escaped, which the other builders in this file already do and
 * this one did not. `<Dial>` is the one verb where unescaped content is not a
 * broken sentence but a different call: text carrying `</Dial><Dial>…` appends a
 * second destination, and the family's Twilio account pays for wherever it goes.
 * The number is a stored family setting (`family_contact_channels.forward_to_phone`,
 * which a manager sets) and the callerId comes off the provider's callback, so
 * neither is ours to assume clean: a legacy row holding "Mom & Dad 555-0200"
 * used to emit a document Twilio could not parse, and the neighbour calling the
 * family line heard an application error and was dropped rather than being put
 * through. Defence in depth rather than the only boundary: the E.164 normaliser
 * in the action is the other half. Audit C1-S7-05.
 */
export function twimlDial(phoneNumber: string, callerId?: string): string {
  const callerAttr = callerId ? ` callerId="${xml(callerId)}"` : '';
  return `<Dial${callerAttr}>${xml(phoneNumber)}</Dial>`;
}

/** TwiML: hang up. */
export function twimlHangup(): string {
  return '<Hangup />';
}

/** TwiML: pause. */
export function twimlPause(seconds = 1): string {
  return `<Pause length="${xml(seconds)}" />`;
}

/** Wrap TwiML elements in the standard XML envelope. */
export function wrapTwiml(...elements: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${elements.join('')}</Response>`;
}

// ─── Twilio REST Calls ──────────────────────────────────────────────────────

/** Send an SMS. `signal` is the caller's deadline; the request's own 15 s ceiling applies as well. */
export async function sendSms(to: string, body: string, options: { from?: string; signal?: AbortSignal } = {}): Promise<void> {
  await twilioFetch('/Messages.json', { To: to, From: options.from ?? TWILIO_PHONE_NUMBER, Body: body }, options.signal);
}

/** Acceptance is a provider receipt, not proof that a handset received the SMS. */
export type SmsReceiptResult =
  | { kind: 'accepted'; messageSid: string; providerStatus: string }
  | { kind: 'retryable'; code: 'rate_limited' }
  | { kind: 'rejected'; code: 'provider_rejected' | 'invalid_message' }
  | { kind: 'unconfigured' }
  /** Our credentials or account were refused (401/403/404): nothing was sent, and the message is not at fault. */
  | { kind: 'misconfigured' }
  | { kind: 'unknown' };

/** A single attempt for durable callers; never retries an ambiguous external send. */
export async function sendSmsWithReceipt(to: string, body: string, signal?: AbortSignal): Promise<SmsReceiptResult> {
  if (!isTwilioConfigured()) return { kind: 'unconfigured' };
  if (!/^\+[1-9]\d{7,14}$/.test(to) || !body.trim() || body.length > 1600) return { kind: 'rejected', code: 'invalid_message' };
  let response: Response | undefined;
  try {
    response = await fetchWithDeadline(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST', redirect: 'manual', cache: 'no-store', headers: { authorization: authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : undefined,
      body: new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: body }).toString(),
    }, 15_000);
    if (response.status === 429) return { kind: 'retryable', code: 'rate_limited' };
    if (response.status === 408) return { kind: 'unknown' };
    // A wrong or rotated auth token (401), a suspended or unauthorized account
    // (403) or a wrong account SID in the URL (404) refuses the REQUEST, not the
    // message. Calling those 'rejected' made every urgent text sent during a
    // credential misconfiguration permanently dropped; they are configuration
    // failures that recover once the configuration is fixed.
    if (response.status === 401 || response.status === 403 || response.status === 404) return { kind: 'misconfigured' };
    if (response.status >= 400 && response.status < 500) return { kind: 'rejected', code: 'provider_rejected' };
    if (response.status !== 201) return { kind: 'unknown' };
    const data = await readBoundedResponseJson<{ sid?: unknown; status?: unknown }>(response, 64 * 1024);
    if (typeof data?.sid !== 'string' || !/^(SM|MM)[0-9a-f]{32}$/i.test(data.sid) || typeof data.status !== 'string' ||
        !['accepted', 'queued', 'sending', 'sent', 'delivered', 'read'].includes(data.status)) return { kind: 'unknown' };
    return { kind: 'accepted', messageSid: data.sid, providerStatus: data.status };
  } catch { return { kind: 'unknown' }; }
  finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}

/** Initiate an outbound call (e.g., emergency escalation). `signal` is the caller's deadline. */
export async function initiateCall(params: {
  to: string;
  from?: string;
  twimlUrl: string;
  statusCallbackUrl?: string;
  signal?: AbortSignal;
}): Promise<{ callSid: string }> {
  const body: Record<string, string> = {
    To: params.to,
    From: params.from ?? TWILIO_PHONE_NUMBER,
    Url: params.twimlUrl,
  };
  if (params.statusCallbackUrl) body.StatusCallback = params.statusCallbackUrl;
  const data = await twilioFetch('/Calls.json', body, params.signal) as { sid: string };
  return { callSid: data.sid };
}

/** Update a live call (e.g., transfer mid-call by updating the call's URL). */
export async function updateCall(callSid: string, twimlUrl: string): Promise<void> {
  await twilioFetch(`/Calls/${callSid}.json`, { Url: twimlUrl, Method: 'POST' });
}

/**
 * True when this environment holds the secret a Twilio signature is checked
 * against — i.e. when `validateTwilioSignature` is capable of ever returning
 * true. Distinct from `isTwilioConfigured`, which also wants an account SID and
 * a phone number because it gates OUTBOUND calls; verifying an INBOUND one
 * needs the auth token and nothing else.
 *
 * Read through a function rather than exported as a const so a caller sees the
 * same captured value this module signs with.
 */
export function twilioSignatureConfigured(): boolean {
  return !!TWILIO_AUTH_TOKEN;
}

/** Validate that a request came from Twilio by checking the signature. */
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!TWILIO_AUTH_TOKEN) return false;
  try {
    const crypto = require('crypto') as typeof import('crypto');
    // Sort params alphabetically and concatenate to URL
    const sortedKeys = Object.keys(params).sort();
    const paramStr = sortedKeys.map((k) => `${k}${params[k] ?? ''}`).join('');
    const strToSign = url + paramStr;
    const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(strToSign).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Number Provisioning ────────────────────────────────────────────────────

/** Search the account for one available US local number (optionally by area
 *  code). Returns an E.164 number, or null when none are available/configured. */
export async function searchAvailableNumber(areaCode?: string): Promise<string | null> {
  if (!isTwilioConfigured()) return null;
  const qs = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1' });
  if (areaCode && /^\d{3}$/.test(areaCode)) qs.set('AreaCode', areaCode);
  const data = await twilioFetch(`/AvailablePhoneNumbers/US/Local.json?${qs.toString()}`) as {
    available_phone_numbers?: { phone_number: string }[];
  };
  return data.available_phone_numbers?.[0]?.phone_number ?? null;
}

/** Buy a number and point its Voice + SMS webhooks at our Contact Center routes.
 *  Returns the provisioned number + its Twilio SID. */
export async function provisionNumber(params: {
  phoneNumber: string; voiceUrl: string; smsUrl: string; friendlyName?: string;
}): Promise<{ phoneNumber: string; sid: string }> {
  const data = await twilioFetch('/IncomingPhoneNumbers.json', {
    PhoneNumber: params.phoneNumber,
    VoiceUrl: params.voiceUrl,
    VoiceMethod: 'POST',
    SmsUrl: params.smsUrl,
    SmsMethod: 'POST',
    ...(params.friendlyName ? { FriendlyName: params.friendlyName } : {}),
  }) as { sid: string; phone_number: string };
  return { phoneNumber: data.phone_number, sid: data.sid };
}

/** The SID of a number THIS account already owns, or null.
 *
 *  A purchase whose response we never saw (the 15s deadline) may still have
 *  completed at the provider, and without this the number cannot even be named
 *  afterwards: it keeps billing and keeps posting to our webhooks forever. */
export async function findOwnedNumberSid(phoneNumber: string): Promise<string | null> {
  if (!isTwilioConfigured() || !phoneNumber) return null;
  const qs = new URLSearchParams({ PhoneNumber: phoneNumber, PageSize: '1' });
  const data = await twilioFetch(`/IncomingPhoneNumbers.json?${qs.toString()}`) as {
    incoming_phone_numbers?: { sid?: unknown; phone_number?: unknown }[];
  };
  const found = data.incoming_phone_numbers?.[0];
  if (!found || found.phone_number !== phoneNumber || typeof found.sid !== 'string') return null;
  return found.sid;
}

/** Give a number back. True ONLY when the provider confirmed it is gone (204) or
 *  had already lost it (404) — the same end state. Any other answer is false and
 *  a transport failure rejects: an unreleased number keeps billing, so the
 *  caller has to be able to see that it is still there. */
export async function releaseNumber(sid: string): Promise<boolean> {
  if (!isTwilioConfigured() || !/^PN[0-9a-f]{32}$/i.test(sid)) return false;
  let res: Response | undefined;
  try {
    res = await fetchWithDeadline(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`,
      { method: 'DELETE', redirect: 'manual', cache: 'no-store', headers: { authorization: authHeader() } },
      15_000,
    );
    return res.status === 204 || res.status === 404;
  } finally {
    if (res?.body && !res.body.locked) await res.body.cancel().catch(() => undefined);
  }
}

/** Look up caller ID name via Twilio Lookup API. */
export async function lookupCallerName(phoneNumber: string): Promise<string | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const url = `https://lookups.twilio.com/v1/PhoneNumbers/${encodeURIComponent(phoneNumber)}?Type=caller-name`;
    const res = await fetchWithDeadline(url, { headers: { authorization: authHeader() } }, 15_000);
    if (!res.ok) return null;
    const data = await readBoundedResponseJson<{ caller_name?: { caller_name?: string } }>(res, 256 * 1024);
    return data.caller_name?.caller_name ?? null;
  } catch {
    return null;
  }
}
