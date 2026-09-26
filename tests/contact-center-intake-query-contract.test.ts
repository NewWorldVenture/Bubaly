// Installed PostgREST SDK against synthetic HTTP. This verifies the wire
// contract; it does not claim to execute PostgreSQL's partial-index inference.
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordInboundMessage } from '@/lib/contact-center/server';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const input = { familyId: FAMILY, channel: 'sms' as const, providerRef: 'SM_synthetic_inbound', body: 'Urgent help', aiIntent: 'urgent' };
const row = { id: MESSAGE, family_id: FAMILY, channel: 'sms', provider_ref: input.providerRef, direction: 'inbound' };
type Reply = { data: unknown; status?: number; count?: number; throws?: boolean };
let replies: Reply[], requests: { url: URL; method: string; headers: Headers; body: unknown }[];
const client = () => createClient<Database>('https://synthetic.invalid', 'synthetic-service-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (url, init) => {
    requests.push({ url: new URL(String(url)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = replies.shift();
    if (!reply || reply.throws) throw new DOMException('Synthetic transport unavailable', 'AbortError');
    return new Response(JSON.stringify(reply.data), { status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.count === undefined ? {} : { 'content-range': `0-1/${reply.count}` }) } });
  } },
});
beforeEach(() => { replies = []; requests = []; });

describe('Contact Center capture with the installed query client', () => {
  it('uses plain insert without an uninferable on_conflict target', async () => {
    replies = [{ data: [], count: 0 }, { data: [{ id: MESSAGE }], status: 201 }];
    expect(await recordInboundMessage(client(), input)).toMatchObject({ inserted: true, messageId: MESSAGE });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(requests[0].headers.get('prefer')).toContain('count=exact');
    expect(requests[0].url.searchParams.get('limit')).toBe('2');
    expect(requests[1].url.searchParams.has('on_conflict')).toBe(false);
    expect(requests[1].headers.get('prefer')).not.toContain('resolution=');
    expect(requests[1].body).toMatchObject({ family_id: FAMILY, direction: 'inbound', provider_ref: input.providerRef });
  });
  it('resolves a racing 23505 only through an exact verified duplicate', async () => {
    replies = [{ data: [], count: 0 }, { data: { code: '23505', message: 'synthetic collision' }, status: 409 }, { data: [row], count: 1 }];
    expect(await recordInboundMessage(client(), input)).toMatchObject({ inserted: false, messageId: MESSAGE });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(requests[2].url.searchParams.get('channel')).toBe('eq.sms');
    expect(requests[2].url.searchParams.get('provider_ref')).toBe(`eq.${input.providerRef}`);
  });
  it.each([
    ['family', { ...row, family_id: 'other-family' }], ['direction', { ...row, direction: 'outbound' }],
    ['channel', { ...row, channel: 'email' }], ['provider', { ...row, provider_ref: 'other' }],
  ])('rejects a duplicate with mismatched %s before a write', async (_label, wrong) => {
    replies = [{ data: [wrong], count: 1 }];
    await expect(recordInboundMessage(client(), input)).rejects.toThrow('Inbound identity mismatch');
    expect(requests).toHaveLength(1);
  });
  it.each([
    { data: [row], count: 2 }, { data: [row] },
    { data: { code: '08006', message: 'private synthetic error' }, status: 503 }, { data: null, throws: true },
  ])('fails closed on incomplete or failed duplicate reads: %j', async reply => {
    replies = [reply];
    await expect(recordInboundMessage(client(), input)).rejects.toThrow('Inbound identity read failed');
    expect(requests).toHaveLength('status' in reply && reply.status === 503 ? 2 : 1); // Installed SDK retries a transient GET.
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each(['23505', '23503', '42P10'])('does not disguise %s without a verified delivery', async code => {
    replies = [{ data: [], count: 0 }, { data: { code, message: 'private synthetic error' }, status: 409 }, { data: [], count: 0 }];
    await expect(recordInboundMessage(client(), input)).rejects.toThrow('Inbound message persistence failed');
  });
});
