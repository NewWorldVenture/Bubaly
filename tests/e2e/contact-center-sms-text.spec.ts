import { expect, test } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

const TOKEN = 'ci-only-guardian-signed-ingress-fixture';
const TOOL = 'contact_center.sms_reply';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function oldReceiptUuid(value: string) {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function callback(origin: string, fields: Record<string, string>) {
  const url = `${origin}/api/contact-center/sms`;
  const signed = url + Object.keys(fields).sort().map(key => key + fields[key]).join('');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': createHmac('sha1', TOKEN).update(signed).digest('base64') },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, emits: /<Message(?:\s|>)/.test(await response.text()) };
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe('Contact Center text boundaries through disposable PostgreSQL and signed HTTP', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires disposable local Supabase.');
  test.setTimeout(180_000);

  test('persists Unicode safely, bounds fallback replies and holds an oversized historical candidate unchanged', async ({ baseURL }) => {
    const appOrigin = requireLocalOrigin(baseURL), origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (process.env.TWILIO_AUTH_TOKEN !== TOKEN || process.env.TWILIO_ACCOUNT_SID
      || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      throw new Error('SMS text E2E requires isolated synthetic configuration.');
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!serviceKey) throw new Error('SMS text E2E needs disposable backend configuration.');
    const admin = createClient<Database>(origin, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
      }) },
    });
    let account: OwnedAccount | undefined;
    try {
      account = await createOwnedAccount(origin, serviceKey);
      const familyId = account.familyId;
      const name = await admin.from('families').update({ name: 'n'.repeat(1550) })
        .eq('id', familyId).eq('created_by', account.userId).select('id');
      expect(!name.error && name.data?.length === 1, 'Change only the owned household name').toBe(true);
      const suffix = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 10_000_000_000n;
      const phone = `+1${suffix.toString().padStart(10, '0')}`, sender = '+12025550198';
      const channel = await admin.from('family_contact_channels').insert({
        family_id: familyId, phone_number: phone, ai_concierge_enabled: true,
      }).select('family_id');
      expect(!channel.error && channel.data?.length === 1).toBe(true);
      const cases = [
        { body: `offer ${'a'.repeat(132)}😀 tail`, stored: `offer ${'a'.repeat(132)}😀 tail` },
        { body: 'A special offer\u0000 with 😀', stored: 'A special offer\ufffd with 😀' },
        // This exceeds the application's cap deliberately; it is not a claim
        // that the provider normally forwards a message of this length.
        { body: `offer ${'a'.repeat(4089)}😀`, stored: `offer ${'a'.repeat(4089)}` },
      ];
      for (const sample of cases) {
        const providerSid = `SM${randomUUID().replaceAll('-', '')}`;
        const fields = { MessageSid: providerSid, From: sender, To: phone, Body: sample.body };
        expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: true });
        const incoming = await admin.from('family_inbox_messages').select('*').eq('family_id', familyId)
          .eq('channel', 'sms').eq('provider_ref', providerSid).single();
        expect(incoming.error).toBeNull();
        expect(incoming.data?.body).toBe(sample.stored);
        expect(incoming.data?.ai_summary?.length).toBeLessThanOrEqual(140);
        const key = `${TOOL}:v1:${hash(JSON.stringify([familyId, 'sms', providerSid.toLowerCase()]))}`;
        const receiptId = oldReceiptUuid(key);
        const receipt = () => admin.from('ai_tool_calls').select('*').eq('family_id', familyId).eq('id', receiptId).single();
        const saved = await receipt();
        expect(saved.error).toBeNull();
        expect(saved.data?.outputs).toMatchObject({ phase: 'emission_reserved' });
        const outgoing = await admin.from('family_inbox_messages').select('*').eq('family_id', familyId)
          .eq('channel', 'sms').eq('provider_ref', `${TOOL}:outbound:${receiptId}`).single();
        expect(outgoing.error).toBeNull();
        expect(outgoing.data?.body?.length).toBeLessThanOrEqual(320);
        expect(outgoing.data?.body).toContain('Thanks for the offer.');
        expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: false });
        expect((await receipt()).data).toEqual(saved.data);
      }

      // Seed an owned, valid older version-one queued receipt and its archived
      // display projection. Its immutable reply must not be shortened or sent.
      const providerSid = `SM${randomUUID().replaceAll('-', '')}`, inboundId = randomUUID();
      const binding = { familyId, channelId: familyId, smsSid: providerSid, from: sender, to: phone, body: 'A historical special offer' };
      const candidate = { summary: 'A saved offer', intent: 'sales', reply: 'x'.repeat(1600), locale: 'en-US', suppression: null };
      const key = `${TOOL}:v1:${hash(JSON.stringify([familyId, 'sms', providerSid.toLowerCase()]))}`;
      const receiptId = oldReceiptUuid(key), outboundId = oldReceiptUuid(`${TOOL}:outbound:${receiptId}`);
      const messages = await admin.from('family_inbox_messages').insert([
        { id: inboundId, family_id: familyId, channel: 'sms', direction: 'inbound', from_addr: sender, to_addr: phone,
          body: binding.body, ai_summary: candidate.summary, ai_intent: candidate.intent, ai_handled: true, status: 'read', provider_ref: providerSid },
        { id: outboundId, family_id: familyId, channel: 'sms', direction: 'outbound', from_addr: phone, to_addr: sender,
          body: candidate.reply, ai_handled: true, status: 'archived', provider_ref: `${TOOL}:outbound:${receiptId}` },
      ]).select('id');
      expect(!messages.error && messages.data?.length === 2).toBe(true);
      const old = await admin.from('ai_tool_calls').insert({ id: receiptId, family_id: familyId, tool_name: TOOL, actor_kind: 'system',
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
        inputs: { version: 1, policyVersion: 1, binding, candidate, fingerprint: hash(JSON.stringify({ binding, candidate })) },
        outputs: { version: 1, revision: randomUUID(), phase: 'queued', inboundId, outboundId: null,
          emissionToken: null, emissionReservedAt: null, reason: null },
        state: 'reserved', attempt: 0, locked_at: null, duration_ms: null, error: null, finished_at: null,
        idempotency_key: key, resource_table: 'family_inbox_messages', resource_id: inboundId,
      }).select('*').single();
      expect(old.error).toBeNull();
      const projections = () => admin.from('family_inbox_messages').select('*').eq('family_id', familyId).in('id', [inboundId, outboundId]).order('id');
      const before = await projections();
      expect(before.error).toBeNull();
      const fields = { MessageSid: providerSid, From: sender, To: phone, Body: binding.body };
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: false });
      const held = () => admin.from('ai_tool_calls').select('*').eq('family_id', familyId).eq('id', receiptId).single();
      const saved = await held();
      expect(saved.error).toBeNull();
      expect(saved.data?.inputs).toEqual(old.data?.inputs);
      expect(saved.data?.outputs).toMatchObject({ phase: 'suppressed', reason: 'unsupported_content', emissionToken: null });
      expect((await projections()).data).toEqual(before.data);
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: false });
      expect((await held()).data).toEqual(saved.data);
      expect((await projections()).data).toEqual(before.data);
    } finally { if (account) await account.dispose(); }
  });
});
