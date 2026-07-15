// lib/guardian/twilio.ts — Twilio REST API helpers (no npm package, raw fetch).
// Covers: TwiML generation, call control, SMS, number provisioning.

import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? '';

function authHeader(): string {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${creds}`;
}

async function twilioFetch(path: string, body?: Record<string, string>): Promise<unknown> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`;
  const res = await fetchExternal(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: authHeader(),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
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

/** TwiML: say text via TTS. */
export function twimlSay(text: string, voice = 'Polly.Joanna-Neural'): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Say voice="${voice}">${escaped}</Say>`;
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
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Gather input="speech" action="${action}" timeout="${timeout}" speechTimeout="${speechTimeout}">
  <Say voice="${voice}">${escaped}</Say>
</Gather>`;
}

/** TwiML: record a voicemail. `action` redirects after recording; omit it to let
 *  the call continue to the next verbs. `transcribeCallback` receives the async
 *  transcription (the `action` POST fires before the transcript is ready). */
export function twimlRecord(opts: {
  action?: string; transcribeCallback?: string; maxLength?: number; text: string; voice?: string;
}): string {
  const { action, transcribeCallback, maxLength = 120, text, voice = 'Polly.Joanna-Neural' } = opts;
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrs = [
    action ? `action="${action}"` : '',
    `maxLength="${maxLength}"`,
    transcribeCallback ? `transcribe="true" transcribeCallback="${transcribeCallback}"` : '',
  ].filter(Boolean).join(' ');
  return `<Say voice="${voice}">${escaped}</Say>
<Record ${attrs} />`;
}

/** TwiML: transfer to a phone number. */
export function twimlDial(phoneNumber: string, callerId?: string): string {
  const callerAttr = callerId ? ` callerId="${callerId}"` : '';
  return `<Dial${callerAttr}>${phoneNumber}</Dial>`;
}

/** TwiML: hang up. */
export function twimlHangup(): string {
  return '<Hangup />';
}

/** TwiML: pause. */
export function twimlPause(seconds = 1): string {
  return `<Pause length="${seconds}" />`;
}

/** Wrap TwiML elements in the standard XML envelope. */
export function wrapTwiml(...elements: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${elements.join('')}</Response>`;
}

// ─── Twilio REST Calls ──────────────────────────────────────────────────────

/** Send an SMS. */
export async function sendSms(to: string, body: string, from = TWILIO_PHONE_NUMBER): Promise<void> {
  await twilioFetch('/Messages.json', { To: to, From: from, Body: body });
}

/** Initiate an outbound call (e.g., emergency escalation). */
export async function initiateCall(params: {
  to: string;
  from?: string;
  twimlUrl: string;
  statusCallbackUrl?: string;
}): Promise<{ callSid: string }> {
  const body: Record<string, string> = {
    To: params.to,
    From: params.from ?? TWILIO_PHONE_NUMBER,
    Url: params.twimlUrl,
  };
  if (params.statusCallbackUrl) body.StatusCallback = params.statusCallbackUrl;
  const data = await twilioFetch('/Calls.json', body) as { sid: string };
  return { callSid: data.sid };
}

/** Update a live call (e.g., transfer mid-call by updating the call's URL). */
export async function updateCall(callSid: string, twimlUrl: string): Promise<void> {
  await twilioFetch(`/Calls/${callSid}.json`, { Url: twimlUrl, Method: 'POST' });
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

/** Look up caller ID name via Twilio Lookup API. */
export async function lookupCallerName(phoneNumber: string): Promise<string | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const url = `https://lookups.twilio.com/v1/PhoneNumbers/${encodeURIComponent(phoneNumber)}?Type=caller-name`;
    const res = await fetchExternal(url, { headers: { authorization: authHeader() } }, 15_000);
    if (!res.ok) return null;
    const data = await readBoundedResponseJson<{ caller_name?: { caller_name?: string } }>(res, 256 * 1024);
    return data.caller_name?.caller_name ?? null;
  } catch {
    return null;
  }
}
