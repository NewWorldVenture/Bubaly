import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isValidGuardianEventId } from './callbacks';
import { smsStep } from './sms-deadline';

type Client = SupabaseClient<Database>;
type Receipt = Database['public']['Tables']['guardian_callback_events']['Row'];
export type VoicemailLease = { eventId: string; communicationId: string; token: string };
export type VoicemailClaim = { kind: 'claimed'; lease: VoicemailLease } | { kind: 'settled' | 'unavailable' };
const TYPE = 'voicemail_recording';
const COLUMNS = 'event_id,callback_type,status,received_at,processed_at,error';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefix = (communicationId: string) => `voicemail:${communicationId}:`;
const marker = (lease: VoicemailLease) => `${prefix(lease.communicationId)}${lease.token}`;
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function receipt(data: unknown, eventId: string): Receipt | null {
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') return null;
  const row = data[0] as Receipt;
  return row.event_id === eventId && row.callback_type === TYPE && ['processing', 'processed', 'error'].includes(row.status)
    && time(row.received_at) && (row.processed_at === null || time(row.processed_at))
    && (row.error === null || typeof row.error === 'string') ? row : null;
}
function unavailable(): never { throw new Error('Voicemail intake unavailable'); }

/** The permanent provider recording ID survives every retry; only the worker token changes. */
export async function claimGuardianVoicemail(client: Client, eventId: string, communicationId: string, signal?: AbortSignal): Promise<VoicemailClaim> {
  if (!isValidGuardianEventId(eventId) || !UUID.test(communicationId)) return { kind: 'unavailable' };
  const lease: VoicemailLease = { eventId, communicationId, token: randomUUID() };
  const now = new Date().toISOString();
  try {
    const inserted = await smsStep(signal, current => client.from('guardian_callback_events').insert({
      event_id: eventId, callback_type: TYPE, status: 'processing', received_at: now, processed_at: null, error: marker(lease),
    }).select(COLUMNS).retry(false).abortSignal(current));
    if (!inserted.error) {
      const saved = receipt(inserted.data, eventId);
      return saved?.status === 'processing' && saved.error === marker(lease) && saved.processed_at === null
        ? { kind: 'claimed', lease } : { kind: 'unavailable' };
    }
    if (inserted.error.code !== '23505') return { kind: 'unavailable' };
    const loaded = await smsStep(signal, current => client.from('guardian_callback_events').select(COLUMNS)
      .eq('event_id', eventId).limit(2).retry(false).abortSignal(current));
    if (loaded.error) return { kind: 'unavailable' };
    const prior = receipt(loaded.data, eventId);
    if (!prior) return { kind: 'unavailable' };
    // Old completed receipts remain completed. New receipts additionally bind
    // the recording to its original communication across every lease/retry.
    if (prior.error?.startsWith('voicemail:') && !prior.error.startsWith(prefix(communicationId))) return { kind: 'unavailable' };
    if (prior.status === 'processed') return time(prior.processed_at) ? { kind: 'settled' } : { kind: 'unavailable' };
    if (prior.status === 'processing' && Date.parse(prior.received_at) >= Date.now() - 10 * 60_000) return { kind: 'unavailable' };
    const reclaimed = await smsStep(signal, current => {
      let query = client.from('guardian_callback_events').update({ status: 'processing', received_at: now, processed_at: null, error: marker(lease) })
        .eq('event_id', eventId).eq('callback_type', TYPE).eq('status', prior.status).eq('received_at', prior.received_at);
      query = prior.error === null ? query.is('error', null) : query.eq('error', prior.error);
      return query.select(COLUMNS).retry(false).abortSignal(current);
    });
    if (reclaimed.error) return { kind: 'unavailable' };
    const saved = receipt(reclaimed.data, eventId);
    return saved?.status === 'processing' && saved.error === marker(lease) && saved.processed_at === null
      ? { kind: 'claimed', lease } : { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
}

export async function requireGuardianVoicemailLease(client: Client, lease: VoicemailLease, signal?: AbortSignal): Promise<void> {
  const result = await smsStep(signal, current => client.from('guardian_callback_events').select(COLUMNS)
    .eq('event_id', lease.eventId).eq('callback_type', TYPE).eq('status', 'processing').eq('error', marker(lease))
    .limit(2).retry(false).abortSignal(current));
  const saved = result.error ? null : receipt(result.data, lease.eventId);
  if (!saved || saved.status !== 'processing' || saved.error !== marker(lease)) unavailable();
}

async function finalize(client: Client, lease: VoicemailLease, status: 'processed' | 'error', signal?: AbortSignal): Promise<boolean> {
  const processedAt = status === 'processed' ? new Date().toISOString() : null;
  const error = `${prefix(lease.communicationId)}${status}`;
  try {
    const result = await smsStep(signal, current => client.from('guardian_callback_events').update({ status, processed_at: processedAt, error })
      .eq('event_id', lease.eventId).eq('callback_type', TYPE).eq('status', 'processing').eq('error', marker(lease))
      .select(COLUMNS).retry(false).abortSignal(current));
    const saved = result.error ? null : receipt(result.data, lease.eventId);
    return !!saved && saved.status === status && saved.error === error
      && (processedAt === null ? saved.processed_at === null : time(saved.processed_at) && Date.parse(saved.processed_at) === Date.parse(processedAt));
  } catch { return false; }
}

export const finishGuardianVoicemail = (client: Client, lease: VoicemailLease, signal?: AbortSignal) => finalize(client, lease, 'processed', signal);
export const releaseGuardianVoicemail = (client: Client, lease: VoicemailLease, signal?: AbortSignal) => finalize(client, lease, 'error', signal);

/** A separate namespace from SMS receipts, stable even after a notification is read. */
export function guardianVoicemailReceiptId(recordingId: string): string {
  const hex = createHash('sha256').update(`guardian-voicemail:${recordingId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
