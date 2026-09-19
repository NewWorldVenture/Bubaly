import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimGuardianVoicemail, finishGuardianVoicemail, releaseGuardianVoicemail } from '@/lib/guardian/voicemail-intake';

const seam = vi.hoisted(() => ({ client: null as unknown as SupabaseClient }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.client }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-voicemail.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const COMM = '33333333-3333-4333-8333-333333333333';
const SID = `RE${'a'.repeat(32)}`;
type Row = Record<string, unknown>;
type Stage = 'claim' | 'communication-read' | 'communication-write' | 'scope' | 'notification-read' | 'notification-write' | 'finish';
let event: Row | null, communication: Row, notifications: Row[], calls: { table: string; method: string }[];
let failure: Stage | null, transport: boolean;
let lost: Stage | null, beforeRead: (() => void | Promise<void>) | null, quiet: Row[];
function matches(row: Row, url: URL) {
  return [...url.searchParams].every(([key, value]) => {
    if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
    if (value.startsWith('is.')) return value === 'is.null' && row[key] === null;
    if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[key]));
    if (value.startsWith('lt.')) return Date.parse(String(row[key])) < Date.parse(value.slice(3));
    return true;
  });
}
function result(rows: Row[], url: URL, init: RequestInit, status = 200) {
  if (init.method !== 'GET' && !url.searchParams.has('select')) return new Response(null, { status: 204 });
  const single = new Headers(init.headers).get('accept')?.includes('vnd.pgrst.object');
  return Response.json(single ? rows[0] ?? null : rows, { status, headers: { 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' } });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live transport prohibited'); }));
  event = null; notifications = []; calls = []; failure = null; transport = false;
  lost = null; beforeRead = null; quiet = [];
  communication = { id: COMM, family_id: FAMILY, member_id: MEMBER, from_number: '+15555550200', from_name: 'Synthetic caller' };
  seam.client = createClient('https://voicemail-db.invalid', 'synthetic-service', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!;
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row | Row[] : null;
      calls.push({ table, method });
      const patch = body && !Array.isArray(body) ? body : {};
      const stage: Stage | null = table === 'guardian_callback_events'
        ? method === 'POST' ? 'claim' : method === 'PATCH' && patch.status === 'processed' ? 'finish' : null
        : table === 'guardian_communications' ? method === 'GET' ? 'communication-read' : 'communication-write'
          : table === 'families' ? 'scope' : table === 'notifications' ? method === 'GET' ? 'notification-read' : 'notification-write' : null;
      if (failure && stage === failure) {
        if (transport) throw new Error('Synthetic unavailable transport');
        return Response.json({ code: 'PGRST000', message: 'Synthetic required storage outage' }, { status: 503, headers: { 'retry-after': '0' } });
      }
      if (table === 'guardian_callback_events') {
        if (method === 'POST') {
          if (event) return Response.json({ code: '23505', message: 'Duplicate permanent recording ID' }, { status: 409 });
          event = { status: 'processing', received_at: new Date().toISOString(), processed_at: null, error: null, ...patch };
        }
        if (method === 'PATCH') {
          const selected = event && matches(event, url) ? event : null;
          if (selected) Object.assign(selected, patch);
          if (stage && stage === lost) throw new Error('Synthetic lost committed response');
          return result(selected ? [selected] : [], url, init);
        }
        return result(event && matches(event, url) ? [event] : [], url, init, method === 'POST' ? 201 : 200);
      }
      if (table === 'guardian_communications') {
        if (method === 'GET') await beforeRead?.();
        if (method === 'PATCH' && matches(communication, url)) Object.assign(communication, patch);
        if (stage && stage === lost) throw new Error('Synthetic lost committed response');
        return result(matches(communication, url) ? [communication] : [], url, init);
      }
      if (table === 'families') return result([{ id: FAMILY, timezone: 'UTC' }], url, init);
      if (table === 'family_ai_settings') return result(quiet, url, init);
      if (table === 'notifications') {
        if (method === 'POST') {
          for (const row of Array.isArray(body) ? body : [patch]) {
            if (row.id && notifications.some(item => item.id === row.id)) return Response.json({ code: '23505', message: 'Duplicate notification ID' }, { status: 409 });
            notifications.push({ id: '44444444-4444-4444-8444-444444444444', is_read: false, ...row });
          }
        }
        if (stage && stage === lost) throw new Error('Synthetic lost committed response');
        return result(notifications.filter(row => matches(row, url)), url, init, method === 'POST' ? 201 : 200);
      }
      throw new Error(`Unexpected fixture table ${table}`);
    } },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function deliver(commId = COMM, validSignature = true, signal?: AbortSignal) {
  const fields = { RecordingSid: SID, RecordingUrl: 'https://api.twilio.invalid/synthetic-recording', RecordingDuration: '30', TranscriptionText: 'Synthetic voicemail' };
  const url = `${ORIGIN}/api/guardian/status/voicemail?commId=${commId}`;
  const sorted = Object.keys(fields).sort().map(key => key + fields[key as keyof typeof fields]).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  const route = await import('@/app/api/guardian/status/voicemail/route');
  return route.POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': validSignature ? signature : 'invalid' }, body: new URLSearchParams(fields), signal }));
}

describe('signed voicemail callbacks retain failures for retry', () => {
  it('preserves a healthy voicemail and acknowledges a completed retry once', async () => {
    const response = await deliver();
    expect(response.status, JSON.stringify({ event, communication, notifications, calls })).toBe(200);
    expect(communication.call_recording_url).toBe('https://api.twilio.invalid/synthetic-recording');
    expect(event?.status).toBe('processed'); expect(notifications).toHaveLength(1);
    notifications[0].is_read = true;
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1);
  });
  for (const stage of ['claim', 'communication-read', 'communication-write', 'scope', 'notification-read', 'notification-write', 'finish'] as const) {
    it.each([false, true])(`returns 503 for ${stage} failure (transport=%s) and recovers once on retry`, async thrown => {
      failure = stage; transport = thrown;
      expect((await deliver()).status).toBe(503);
      expect(event?.status).not.toBe('processed');
      if (stage !== 'finish') expect(notifications).toHaveLength(0);
      failure = null;
      expect((await deliver()).status).toBe(200);
      expect(event?.status).toBe('processed'); expect(notifications).toHaveLength(1);
    });
  }
  it('rejects an invalid signature before any database operation', async () => {
    expect((await deliver(COMM, false)).status).toBe(401); expect(calls).toEqual([]);
  });
  it.each(['communication-write', 'notification-write', 'finish'] as const)('reconciles a lost committed %s response without duplicate notification', async stage => {
    lost = stage;
    expect((await deliver()).status).toBe(stage === 'finish' ? 503 : 200);
    expect(notifications).toHaveLength(1);
    notifications[0].is_read = true; lost = null;
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1);
    expect(event?.event_id).toBe(SID);
  });
  it('does not acknowledge an active callback until its worker has completed', async () => {
    const claim = await claimGuardianVoicemail(seam.client, SID, COMM);
    expect(claim.kind).toBe('claimed');
    expect((await deliver()).status).toBe(503); expect(notifications).toEqual([]);
    if (claim.kind !== 'claimed') throw new Error('Fixture claim missing');
    expect(await releaseGuardianVoicemail(seam.client, claim.lease)).toBe(true);
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1);
  });
  it('does not let an older worker complete or release a reclaimed lease', async () => {
    const old = await claimGuardianVoicemail(seam.client, SID, COMM);
    if (old.kind !== 'claimed' || !event) throw new Error('Fixture claim missing');
    event.received_at = '2000-01-01T00:00:00Z';
    const fresh = await claimGuardianVoicemail(seam.client, SID, COMM);
    expect(fresh.kind).toBe('claimed');
    expect(await finishGuardianVoicemail(seam.client, old.lease)).toBe(false);
    expect(await releaseGuardianVoicemail(seam.client, old.lease)).toBe(false);
    expect(event.status).toBe('processing');
  });
  it('keeps a recording bound to its original communication after a failed attempt', async () => {
    failure = 'communication-read'; expect((await deliver()).status).toBe(503);
    failure = null;
    expect((await deliver('55555555-5555-4555-8555-555555555555')).status).toBe(503);
    expect(notifications).toEqual([]);
    expect((await deliver()).status).toBe(200);
  });
  it('stops before notifications when ownership is stolen during the required read', async () => {
    beforeRead = () => { if (event) event.error = `voicemail:${COMM}:newer-worker`; };
    expect((await deliver()).status).toBe(503);
    expect(event?.error).toBe(`voicemail:${COMM}:newer-worker`);
    expect(communication.call_recording_url).toBeUndefined(); expect(notifications).toEqual([]);
  });
  it('bounds a transport that ignores cancellation and recovers on the next request', async () => {
    const controller = new AbortController();
    beforeRead = () => { controller.abort(); return new Promise(() => {}); };
    expect((await deliver(COMM, true, controller.signal)).status).toBe(503);
    expect(event?.status).toBe('error'); expect(notifications).toEqual([]);
    beforeRead = null;
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1);
  });
  it('still defers voicemail notifications through family quiet hours', async () => {
    const hour = new Date().getUTCHours();
    quiet = [{ family_id: FAMILY, quiet_hours_start: hour, quiet_hours_end: (hour + 2) % 24 }];
    expect((await deliver()).status).toBe(200);
    expect(Date.parse(String(notifications[0].send_at))).toBeGreaterThan(Date.now());
  });
});
