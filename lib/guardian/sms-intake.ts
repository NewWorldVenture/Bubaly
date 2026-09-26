import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isValidGuardianEventId } from './callbacks';

export type GuardianSmsLease = { eventId: string; token: string };
export type GuardianSmsClaim = { kind: 'claimed'; lease: GuardianSmsLease } | { kind: 'processed' | 'busy' | 'unavailable' | 'invalid' };
type Client = SupabaseClient<Database>;
type Receipt = Database['public']['Tables']['guardian_callback_events']['Row'];
const TYPE = 'inbound_sms';
const COLUMNS = 'event_id,callback_type,status,received_at,processed_at,error';
const STALE_MS = 10 * 60_000;
const REQUEST_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const marker = (lease: GuardianSmsLease) => `sms-lease:${lease.token}`;
const unavailable = (): GuardianSmsClaim => ({ kind: 'unavailable' });
function validLease(lease: GuardianSmsLease): boolean { return !!lease && isValidGuardianEventId(lease.eventId) && typeof lease.token === 'string' && UUID.test(lease.token); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function sameTime(a: string, b: string): boolean { return Date.parse(a) === Date.parse(b); }
function receipt(data: unknown, eventId: string): Receipt | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row: unknown = data[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (value.event_id !== eventId || typeof value.callback_type !== 'string' || typeof value.status !== 'string'
    || !['processing', 'processed', 'error'].includes(value.status) || !timestamp(value.received_at)
    || (value.processed_at !== null && !timestamp(value.processed_at))
    || (value.error !== null && typeof value.error !== 'string')) return null;
  return value as Receipt;
}

/** Bound each query even when a custom fetch ignores cancellation. */
async function request<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => PromiseLike<T>): Promise<T | null> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('SMS intake request interrupted', 'AbortError'));
  let abortListener: () => void = () => {};
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_MS);
  try {
    if (signal?.aborted) abort();
    if (controller.signal.aborted) return null;
    const interrupted = new Promise<null>(resolve => { abortListener = () => resolve(null); controller.signal.addEventListener('abort', abortListener, { once: true }); });
    return await Promise.race([Promise.resolve(run(controller.signal)), interrupted]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', abortListener);
  }
}

/** SMS-specific intake ownership; this is not an external-send retry lease. */
export async function claimGuardianSms(client: Client, eventId: string, signal?: AbortSignal): Promise<GuardianSmsClaim> {
  if (!isValidGuardianEventId(eventId)) return { kind: 'invalid' };
  const lease: GuardianSmsLease = { eventId, token: randomUUID() };
  const receivedAt = new Date(Date.now()).toISOString();
  const inserted = await request(signal, currentSignal => client.from('guardian_callback_events').insert({
    event_id: eventId, callback_type: TYPE, status: 'processing', received_at: receivedAt, processed_at: null, error: marker(lease),
  }).select(COLUMNS).retry(false).abortSignal(currentSignal));
  if (!inserted) return unavailable();
  if (!inserted.error) {
    const saved = receipt(inserted.data, eventId);
    return saved?.callback_type === TYPE && saved.status === 'processing' && saved.error === marker(lease)
      && saved.processed_at === null && sameTime(saved.received_at, receivedAt) ? { kind: 'claimed', lease } : unavailable();
  }
  if (inserted.error.code !== '23505') return unavailable();

  const loaded = await request(signal, currentSignal => client.from('guardian_callback_events').select(COLUMNS)
    .eq('event_id', eventId).limit(2).retry(false).abortSignal(currentSignal));
  if (!loaded || loaded.error) return unavailable();
  const prior = receipt(loaded.data, eventId);
  if (!prior) return unavailable();
  if (prior.callback_type !== TYPE) return { kind: 'invalid' };
  if (prior.status === 'processed') return timestamp(prior.processed_at) ? { kind: 'processed' } : unavailable();
  if (prior.status === 'processing' && Date.parse(prior.received_at) >= Date.now() - STALE_MS) return { kind: 'busy' };

  const reclaimedAt = new Date(Date.now()).toISOString();
  const reclaimed = await request(signal, currentSignal => {
    let query = client.from('guardian_callback_events').update({ status: 'processing', received_at: reclaimedAt, processed_at: null, error: marker(lease) })
      .eq('event_id', eventId).eq('callback_type', TYPE).eq('status', prior.status).eq('received_at', prior.received_at);
    query = prior.error === null ? query.is('error', null) : query.eq('error', prior.error);
    return query.select(COLUMNS).retry(false).abortSignal(currentSignal);
  });
  if (!reclaimed || reclaimed.error) return unavailable();
  if (Array.isArray(reclaimed.data) && reclaimed.data.length === 0) return { kind: 'busy' };
  const saved = receipt(reclaimed.data, eventId);
  return saved?.callback_type === TYPE && saved.status === 'processing' && saved.error === marker(lease)
    && saved.processed_at === null && sameTime(saved.received_at, reclaimedAt) ? { kind: 'claimed', lease } : unavailable();
}

async function finalize(client: Client, lease: GuardianSmsLease, status: 'processed' | 'error', signal?: AbortSignal): Promise<boolean> {
  if (!validLease(lease)) return false;
  const processedAt = status === 'processed' ? new Date(Date.now()).toISOString() : null;
  const result = await request(signal, currentSignal => client.from('guardian_callback_events').update({ status, processed_at: processedAt, error: null })
    .eq('event_id', lease.eventId).eq('callback_type', TYPE).eq('status', 'processing').eq('error', marker(lease))
    .select(COLUMNS).retry(false).abortSignal(currentSignal));
  if (!result || result.error) return false;
  const saved = receipt(result.data, lease.eventId);
  return !!saved && saved.callback_type === TYPE && saved.status === status && saved.error === null
    && (processedAt === null ? saved.processed_at === null : timestamp(saved.processed_at) && sameTime(saved.processed_at, processedAt));
}

/** Complete only the caller's live lease, with a verified database receipt. */
export function finishGuardianSms(client: Client, lease: GuardianSmsLease, signal?: AbortSignal): Promise<boolean> {
  return finalize(client, lease, 'processed', signal);
}

/** A confirmed pre-completion failure can be reclaimed immediately on retry. */
export function releaseGuardianSms(client: Client, lease: GuardianSmsLease, signal?: AbortSignal): Promise<boolean> {
  return finalize(client, lease, 'error', signal);
}
