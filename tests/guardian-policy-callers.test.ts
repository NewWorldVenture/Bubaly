import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, processed: vi.fn(), scam: vi.fn(), notify: vi.fn(), greeting: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.client }));
vi.mock('@/lib/guardian/callbacks', async original => ({ ...await original<typeof import('@/lib/guardian/callbacks')>(), claimGuardianCallback: async () => true, markGuardianCallbackProcessed: seam.processed }));
vi.mock('@/lib/guardian/twilio', async original => ({ ...await original<typeof import('@/lib/guardian/twilio')>(), lookupCallerName: async () => null }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/guardian/ai-screen', () => ({ buildInitialGreeting: seam.greeting, buildVoicemailPrompt: seam.greeting }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-policy-callback.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const COMM = '44444444-4444-4444-8444-444444444444';
const stages = ['guardian_contacts', 'guardian_member_profiles', 'guardian_routing_rules'] as const;
let calls: { table: string; method: string }[];
let failure: typeof stages[number] | null;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live transport prohibited'); }));
  calls = [];
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.client = createClient('https://guardian-policy-db.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!;
      calls.push({ table, method: init.method ?? 'GET' });
      if (init.method === 'PATCH') return new Response(null, { status: 204 });
      if (table === 'guardian_communications' && init.method === 'POST') return Response.json({ id: COMM }, { status: 201 });
      if (table === 'family_members') return Response.json({ display_name: 'Synthetic member' });
      if (table === 'families') return Response.json({ name: 'Synthetic family' });
      if (table === 'guardian_member_profiles' && url.searchParams.has('guardian_phone')) {
        return Response.json({ id: MEMBER, family_id: FAMILY, member_id: MEMBER });
      }
      if (table === failure) return Response.json({ code: '42501', message: 'Synthetic policy failure' }, { status: 503, headers: { 'retry-after': '0' } });
      if (!failure && table === 'guardian_contacts') return Response.json([{ id: CONTACT, family_id: FAMILY, phone: '+15555550200', name: 'Synthetic blocked contact', trust_level: 'blocked', spam_score: 90 }], { headers: { 'content-range': '0-0/1' } });
      if (stages.includes(table as typeof stages[number])) return Response.json([], { headers: { 'content-range': '*/0' } });
      throw new Error(`Unexpected fixture operation ${init.method ?? 'GET'} ${table}`);
    } },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function deliver(channel: 'voice' | 'whatsapp', validSignature = true) {
  const fields: Record<string, string> = channel === 'voice'
    ? { From: '+15555550200', To: '+15555550100', CallSid: `CA${'a'.repeat(32)}`, CallStatus: 'ringing' }
    : { From: 'whatsapp:+15555550200', To: 'whatsapp:+15555550100', SmsSid: `SM${'a'.repeat(32)}`, Body: 'Synthetic message' };
  const url = `${ORIGIN}/api/guardian/inbound/${channel}`;
  const sorted = Object.keys(fields).sort().map(key => key + fields[key]).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  const route = channel === 'voice' ? await import('@/app/api/guardian/inbound/voice/route') : await import('@/app/api/guardian/inbound/whatsapp/route');
  return route.POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': validSignature ? signature : 'invalid' }, body: new URLSearchParams(fields) }));
}

describe('existing Guardian callers stop on unavailable policy', () => {
  for (const channel of ['voice', 'whatsapp'] as const) {
    it.each(stages)(`${channel}: no routing or notification when %s is unavailable`, async stage => {
      failure = stage;
      const response = await deliver(channel);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/<(?:Dial|Gather|Record|Hangup)\b/i);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(seam.processed).not.toHaveBeenCalled();
      expect(seam.scam).not.toHaveBeenCalled();
      expect(seam.notify).not.toHaveBeenCalled();
      expect(seam.greeting).not.toHaveBeenCalled();
    });
    it(`${channel}: preserves a healthy blocked decision`, async () => {
      failure = null;
      const response = await deliver(channel);
      expect(response.status).toBe(200);
      expect(calls.filter(call => call.method === 'POST' && call.table === 'guardian_communications')).toHaveLength(1);
      expect(seam.processed).toHaveBeenCalledOnce();
      expect(seam.notify).not.toHaveBeenCalled();
      expect(seam.greeting).not.toHaveBeenCalled();
      if (channel === 'voice') expect(await response.text()).toContain('<Hangup');
    });
    it(`${channel}: rejects an invalid production signature before database work`, async () => {
      failure = null;
      expect((await deliver(channel, false)).status).toBe(401);
      expect(calls).toHaveLength(0);
      expect(seam.processed).not.toHaveBeenCalled();
    });
  }
});
