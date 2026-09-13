import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimGuardianSms, finishGuardianSms, releaseGuardianSms } from '@/lib/guardian/sms-intake';

const NOW = Date.parse('2026-09-12T20:00:00Z');
const EVENT = `SM${'1'.repeat(32)}`;
type Row = { event_id: string; callback_type: string; status: string; received_at: string; processed_at: string | null; error: string | null };
type Call = { method: string; url: URL; body: Record<string, unknown> | null; headers: Headers; signal: AbortSignal | null | undefined };
let rows: Map<string, Row>;
let calls: Call[];
let override: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
let transform: ((call: Call, row: Row[]) => unknown) | undefined;
function row(patch: Partial<Row> = {}): Row { return { event_id: EVENT, callback_type: 'inbound_sms', status: 'processing', received_at: new Date(NOW).toISOString(), processed_at: null, error: null, ...patch }; }
function matches(value: Row, url: URL): boolean {
  return [...url.searchParams.entries()].every(([key, filter]) => {
    if (['select', 'limit'].includes(key)) return true;
    const actual = value[key as keyof Row];
    if (filter.startsWith('eq.')) return String(actual) === filter.slice(3);
    if (filter === 'is.null') return actual === null;
    throw new Error(`Unhandled fixture filter ${key}`);
  });
}
function client() {
  return createClient<Database>('https://guardian-sms.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init = {}) => {
      const call: Call = { method: init.method ?? 'GET', url: new URL(String(input)), body: typeof init.body === 'string' ? JSON.parse(init.body) : null, headers: new Headers(init.headers), signal: init.signal };
      calls.push(call);
      expect(call.url.pathname).toBe('/rest/v1/guardian_callback_events');
      const custom = override?.(call); if (custom) return custom;
      let output: Row[];
      if (call.method === 'POST') {
        const candidate = call.body as unknown as Row;
        if (rows.has(candidate.event_id)) return Response.json({ code: '23505', message: 'synthetic duplicate' }, { status: 409 });
        const saved = { ...candidate }; rows.set(candidate.event_id, saved); output = [saved];
      } else {
        output = [...rows.values()].filter(value => matches(value, call.url));
        if (call.method === 'PATCH') {
          output = output.map(value => ({ ...value, ...call.body }));
          output.forEach(value => rows.set(value.event_id, value));
        }
      }
      return Response.json(transform ? transform(call, output) : output, { status: call.method === 'POST' ? 201 : 200 });
    } },
  });
}
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); rows = new Map(); calls = []; override = undefined; transform = undefined; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function ownClaim() {
  const c = client(); const result = await claimGuardianSms(c, EVENT);
  expect(result.kind).toBe('claimed');
  if (result.kind !== 'claimed') throw new Error('Fixture claim unavailable');
  return { c, lease: result.lease };
}

describe('SMS-only callback ownership with actual installed PostgREST requests', () => {
  it('inserts and verifies an owned receipt before returning claimed', async () => {
    const { lease } = await ownClaim();
    expect(lease.eventId).toBe(EVENT);
    expect(lease.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.get(EVENT)).toMatchObject({ callback_type: 'inbound_sms', status: 'processing', error: `sms-lease:${lease.token}` });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('prefer')).toContain('return=representation');
    expect(calls[0].url.searchParams.has('on_conflict')).toBe(false);
  });
  it.each(['', 'bad event', 'a'.repeat(161), '../event'])('rejects invalid identifiers without storage: %s', async eventId => {
    expect(await claimGuardianSms(client(), eventId)).toEqual({ kind: 'invalid' }); expect(calls).toHaveLength(0);
  });
  it.each([400, 403, 409, 503])('reports a required insert failure %i as unavailable, not processed', async status => {
    override = () => Response.json({ code: '08006', message: 'synthetic private database diagnostic' }, { status });
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'unavailable' }); expect(calls).toHaveLength(1);
  });
  it.each(['empty', 'multiple', 'wrong-type', 'wrong-event', 'wrong-lease', 'missing-time'])('rejects malformed successful insert receipt %s', async mode => {
    transform = (_call, result) => {
      if (mode === 'empty') return [];
      if (mode === 'multiple') return [...result, ...result];
      return result.map(value => ({ ...value, ...(mode === 'wrong-type' ? { callback_type: 'inbound_voice' } : mode === 'wrong-event' ? { event_id: 'other' } : mode === 'wrong-lease' ? { error: 'other' } : { received_at: null }) }));
    };
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'unavailable' }); expect(calls).toHaveLength(1);
  });
  it('acknowledges only a checked same-type processed duplicate', async () => {
    rows.set(EVENT, row({ status: 'processed', processed_at: new Date(NOW).toISOString() }));
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'processed' });
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
  });
  it.each(['inbound_voice', 'escalation', ''])('refuses a colliding foreign callback type %s', async callback_type => {
    rows.set(EVENT, row({ callback_type, status: 'processed' }));
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'invalid' });
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
  });
  it('returns busy for a live processing duplicate without touching its lease', async () => {
    const saved = row({ error: 'sms-lease:existing' }); rows.set(EVENT, saved);
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'busy' }); expect(rows.get(EVENT)).toEqual(saved);
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
  });
  it.each(['error', 'stale'])('claims %s with a full exact prior-row CAS', async mode => {
    const saved = row({ status: mode === 'error' ? 'error' : 'processing', received_at: new Date(NOW - (mode === 'error' ? 0 : 600_001)).toISOString(), error: mode === 'error' ? 'Retry required' : null });
    rows.set(EVENT, saved);
    const { lease } = await ownClaim();
    const patch = calls.find(call => call.method === 'PATCH')!;
    expect(patch.url.searchParams.get('event_id')).toBe(`eq.${EVENT}`);
    expect(patch.url.searchParams.get('callback_type')).toBe('eq.inbound_sms');
    expect(patch.url.searchParams.get('status')).toBe(`eq.${saved.status}`);
    expect(patch.url.searchParams.get('received_at')).toBe(`eq.${saved.received_at}`);
    expect(patch.url.searchParams.get('error')).toBe(saved.error === null ? 'is.null' : `eq.${saved.error}`);
    expect(rows.get(EVENT)?.error).toBe(`sms-lease:${lease.token}`);
  });
  it('does not reclaim processing at the exact ten-minute boundary', async () => {
    rows.set(EVENT, row({ received_at: new Date(NOW - 600_000).toISOString() }));
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'busy' });
  });
  it.each(['missing', 'error', 'throw', 'bad-status', 'bad-time', 'multiple'])('fails closed on an unavailable/invalid duplicate read: %s', async mode => {
    rows.set(EVENT, row());
    override = call => {
      if (call.method !== 'GET') return undefined;
      if (mode === 'throw') throw new DOMException('Synthetic private database diagnostic', 'AbortError');
      if (mode === 'error') return Response.json({ code: '08006', message: 'private diagnostic' }, { status: 503 });
      return Response.json(mode === 'missing' ? [] : mode === 'multiple' ? [row(), row()] : [row(mode === 'bad-time' ? { received_at: 'not-time' } : { status: 'unknown' })]);
    };
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'unavailable' });
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
  });
  it('lets exactly one concurrent error reclaim own the row', async () => {
    rows.set(EVENT, row({ status: 'error' }));
    const c = client(); const results = await Promise.all([claimGuardianSms(c, EVENT), claimGuardianSms(c, EVENT)]);
    expect(results.map(result => result.kind).sort()).toEqual(['busy', 'claimed']);
    const winner = results.find(result => result.kind === 'claimed');
    if (winner?.kind !== 'claimed') throw new Error('No winner');
    expect(rows.get(EVENT)?.error).toBe(`sms-lease:${winner.lease.token}`);
  });
  it('returns unavailable when a reclaim write fails rather than claiming ownership', async () => {
    rows.set(EVENT, row({ status: 'error' }));
    override = call => call.method === 'PATCH' ? Response.json({ code: '08006' }, { status: 503 }) : undefined;
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'unavailable' });
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('reports a lost successful CAS as busy without overwriting the winner', async () => {
    rows.set(EVENT, row({ status: 'error' }));
    override = call => call.method === 'PATCH' ? Response.json([]) : undefined;
    expect(await claimGuardianSms(client(), EVENT)).toEqual({ kind: 'busy' });
  });
});

describe('lease-bound completion and immediate safe retry', () => {
  it.each(['finish', 'release'])('performs a checked owner-only %s', async kind => {
    const { c, lease } = await ownClaim();
    expect(await (kind === 'finish' ? finishGuardianSms : releaseGuardianSms)(c, lease)).toBe(true);
    const patch = calls.at(-1)!;
    expect(patch.url.searchParams.get('status')).toBe('eq.processing');
    expect(patch.url.searchParams.get('error')).toBe(`eq.sms-lease:${lease.token}`);
    expect(patch.url.searchParams.get('callback_type')).toBe('eq.inbound_sms');
    expect(rows.get(EVENT)?.status).toBe(kind === 'finish' ? 'processed' : 'error');
    expect(rows.get(EVENT)?.error).toBeNull();
    expect(await claimGuardianSms(c, EVENT)).toMatchObject({ kind: kind === 'finish' ? 'processed' : 'claimed' });
  });
  it('prevents a retired worker from finishing or releasing a newer lease', async () => {
    const first = await ownClaim();
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 600_001);
    const second = await claimGuardianSms(first.c, EVENT);
    if (second.kind !== 'claimed') throw new Error('New lease missing');
    expect(second.lease.token).not.toBe(first.lease.token);
    expect(await finishGuardianSms(first.c, first.lease)).toBe(false);
    expect(await releaseGuardianSms(first.c, first.lease)).toBe(false);
    expect(rows.get(EVENT)?.error).toBe(`sms-lease:${second.lease.token}`);
    expect(await finishGuardianSms(first.c, second.lease)).toBe(true);
  });
  it.each(['error', 'empty', 'mismatch'])('never reports an unverified completion receipt %s as success', async mode => {
    const { c, lease } = await ownClaim();
    override = call => call.method !== 'PATCH' ? undefined : mode === 'error' ? Response.json({ code: '08006' }, { status: 503 }) : Response.json(mode === 'empty' ? [] : [row({ status: 'processed', event_id: 'other' })]);
    expect(await finishGuardianSms(c, lease)).toBe(false); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('rejects malformed lease values without requests', async () => {
    const c = client();
    expect(await finishGuardianSms(c, { eventId: EVENT, token: 'wrong' })).toBe(false);
    expect(await releaseGuardianSms(c, { eventId: '../wrong', token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it.each(['POST', 'GET', 'PATCH'])('bounds a held %s at five seconds without SDK retries', async method => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    if (method !== 'POST') rows.set(EVENT, row({ status: 'error' }));
    override = call => call.method === method ? new Promise((_resolve, reject) => { call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true }); }) : undefined;
    const result = claimGuardianSms(client(), EVENT);
    await vi.waitFor(() => expect(calls.some(call => call.method === method)).toBe(true));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual({ kind: 'unavailable' });
    const held = calls.filter(call => call.method === method);
    expect(held).toHaveLength(1); expect(held[0].signal?.reason?.name).toBe('AbortError');
  });
  it('honors a pre-aborted caller without starting a request', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await claimGuardianSms(client(), EVENT, controller.signal)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(0);
  });
});
