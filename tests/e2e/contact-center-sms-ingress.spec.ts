import { expect, test } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

const TOKEN = 'ci-only-guardian-signed-ingress-fixture';
const INGRESS = 'contact_center.sms_ingress', REPLY = 'contact_center.sms_reply', URGENT = 'contact_center.urgent_delivery';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function receiptId(key: string) {
  const hex = hash(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const ingressId = (sid: string) => receiptId(`${INGRESS}:v1:${sid.toLowerCase()}`);
const replyKey = (family: string, sid: string) => `${REPLY}:v1:${hash(JSON.stringify([family, 'sms', sid.toLowerCase()]))}`;
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
test.describe('Contact Center immutable SMS ingress through disposable PostgreSQL and signed HTTP', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires disposable local Supabase.');
  test.setTimeout(180_000);

  test('binds original input and household while preserving old reply and urgent-only recovery', async ({ baseURL }) => {
    const appOrigin = requireLocalOrigin(baseURL), origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (process.env.TWILIO_AUTH_TOKEN !== TOKEN || process.env.TWILIO_ACCOUNT_SID
      || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      throw new Error('SMS ingress E2E requires isolated synthetic configuration.');
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!serviceKey) throw new Error('SMS ingress E2E needs disposable backend configuration.');
    const admin = createClient<Database>(origin, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
      }) },
    });
    const accounts: OwnedAccount[] = [];
    try {
      accounts.push(await createOwnedAccount(origin, serviceKey));
      accounts.push(await createOwnedAccount(origin, serviceKey));
      const familyId = accounts[0].familyId, otherFamily = accounts[1].familyId;
      const suffix = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 10_000_000_000n;
      const phone = `+1${suffix.toString().padStart(10, '0')}`, sender = '+12025550197';
      const channels = await admin.from('family_contact_channels').insert([
        { family_id: familyId, phone_number: phone, ai_concierge_enabled: true, forward_to_phone: null },
        { family_id: otherFamily, phone_number: null, ai_concierge_enabled: true, forward_to_phone: null },
      ]).select('family_id');
      expect(!channels.error && channels.data?.length === 2, 'Create only two owned test channels').toBe(true);

      // Hash private ledger contents before assertions so even synthetic callback
      // capabilities never appear in a failing snapshot or Playwright trace.
      async function familySnapshot(family: string) {
        const results = await Promise.all([
          admin.from('family_inbox_messages').select('*').eq('family_id', family).order('id'),
          admin.from('ai_tool_calls').select('*').eq('family_id', family).order('id'),
          admin.from('notifications').select('*').eq('family_id', family).order('id'),
          admin.from('ai_requests').select('*').eq('family_id', family).order('id'),
        ]);
        expect(results.every(result => !result.error && Array.isArray(result.data)), 'Read exact owned message effects').toBe(true);
        return hash(JSON.stringify(results.map(result => result.data)));
      }
      async function movePhone(fromFamily: string, toFamily: string) {
        const released = await admin.from('family_contact_channels').update({ phone_number: null })
          .eq('family_id', fromFamily).eq('phone_number', phone).select('family_id');
        expect(!released.error && released.data?.length === 1, 'Release only the owned synthetic number').toBe(true);
        const assigned = await admin.from('family_contact_channels').update({ phone_number: phone })
          .eq('family_id', toFamily).is('phone_number', null).select('family_id');
        expect(!assigned.error && assigned.data?.length === 1, 'Assign only the other owned test channel').toBe(true);
      }
      async function savedRow(id: string) {
        const result = await admin.from('ai_tool_calls').select('*').eq('family_id', familyId).eq('id', id).single();
        expect(result.error === null && !!result.data, 'Read the exact owned receipt').toBe(true);
        return result.data!;
      }
      async function noIngress(sid: string) {
        const result = await admin.from('ai_tool_calls').select('id', { count: 'exact' }).eq('id', ingressId(sid));
        expect(result.error).toBeNull(); expect(result.count).toBe(0); expect(result.data).toEqual([]);
      }

      // Deliberately exceed the application's cap; this tests its boundary,
      // not the length the provider normally forwards.
      const providerSid = `SM${randomUUID().replaceAll('-', '')}`, storedBody = `offer ${'a'.repeat(4090)}`;
      const fields = { MessageSid: providerSid, From: sender, To: phone, Body: `${storedBody}x` };
      expect(fields.Body.length).toBe(4097);
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: true });
      const captured = await savedRow(ingressId(providerSid));
      expect(captured).toMatchObject({ tool_name: INGRESS, actor_kind: 'system', state: 'succeeded', attempt: 1,
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null,
        conversation_id: null, message_id: null, resource_table: null, resource_id: null,
        inputs: { version: 1, normalizationVersion: 1, accountSid: null, bodyDigest: hash(JSON.stringify(fields.Body)),
          binding: { familyId, channelId: familyId, smsSid: providerSid, from: sender, to: phone, body: storedBody } },
        outputs: { version: 1, phase: 'captured' },
      });
      const incoming = await admin.from('family_inbox_messages').select('id,body,direction').eq('family_id', familyId)
        .eq('channel', 'sms').eq('provider_ref', providerSid).single();
      expect(incoming.error).toBeNull(); expect(incoming.data?.body).toBe(storedBody); expect(incoming.data?.direction).toBe('inbound');
      const originalEffects = await familySnapshot(familyId), otherEffects = await familySnapshot(otherFamily);
      expect(await callback(appOrigin, { ...fields, Body: `${storedBody}y` })).toEqual({ status: 503, emits: false });
      expect(await familySnapshot(familyId)).toBe(originalEffects);
      expect(await familySnapshot(otherFamily)).toBe(otherEffects);
      expect(await callback(appOrigin, { ...fields, MessageSid: providerSid.toLowerCase() })).toEqual({ status: 200, emits: false });
      expect(await familySnapshot(familyId)).toBe(originalEffects);
      expect(await savedRow(captured.id)).toEqual(captured);
      await movePhone(familyId, otherFamily);
      expect(await callback(appOrigin, fields)).toEqual({ status: 503, emits: false });
      expect(await familySnapshot(familyId)).toBe(originalEffects);
      expect(await familySnapshot(otherFamily)).toBe(otherEffects);
      await movePhone(otherFamily, familyId);
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: false });
      expect(await familySnapshot(familyId)).toBe(originalEffects);

      // Version-one reply history predates the ingress digest. A global lookup
      // must preserve its owner and stored SID casing, without fabricating one.
      const legacySid = `sm${randomUUID().replaceAll('-', '')}`;
      const binding = { familyId, channelId: familyId, smsSid: legacySid, from: sender, to: phone, body: 'A historical special offer' };
      const candidate = { summary: 'The original saved offer', intent: 'sales', reply: 'The original saved reply', locale: 'en-US', suppression: null };
      const key = replyKey(familyId, legacySid), legacyId = receiptId(key);
      const oldReply = await admin.from('ai_tool_calls').insert({ id: legacyId, family_id: familyId, tool_name: REPLY, actor_kind: 'system',
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
        inputs: { version: 1, policyVersion: 1, binding, candidate, fingerprint: hash(JSON.stringify({ binding, candidate })) },
        outputs: { version: 1, revision: randomUUID(), phase: 'queued', inboundId: null, outboundId: null,
          emissionToken: null, emissionReservedAt: null, reason: null },
        state: 'reserved', attempt: 0, locked_at: null, duration_ms: null, error: null, finished_at: null,
        idempotency_key: key, resource_table: 'family_inbox_messages', resource_id: null,
      }).select('id');
      expect(!oldReply.error && oldReply.data?.length === 1).toBe(true);
      const oldFields = { MessageSid: legacySid.toUpperCase(), From: sender, To: phone, Body: binding.body };
      const oldBefore = await familySnapshot(familyId);
      await movePhone(familyId, otherFamily);
      expect(await callback(appOrigin, oldFields)).toEqual({ status: 503, emits: false });
      expect(await familySnapshot(familyId)).toBe(oldBefore); expect(await familySnapshot(otherFamily)).toBe(otherEffects);
      await noIngress(legacySid); await movePhone(otherFamily, familyId);
      expect(await callback(appOrigin, oldFields)).toEqual({ status: 200, emits: true });
      await noIngress(legacySid);
      const resumed = await savedRow(legacyId);
      expect(resumed.inputs).toMatchObject({ binding, candidate }); expect(resumed.outputs).toMatchObject({ phase: 'emission_reserved' });
      const oldInbound = await admin.from('family_inbox_messages').select('provider_ref,ai_summary').eq('family_id', familyId)
        .eq('channel', 'sms').eq('provider_ref', legacySid).single();
      expect(oldInbound.error).toBeNull(); expect(oldInbound.data).toEqual({ provider_ref: legacySid, ai_summary: candidate.summary });
      expect(await callback(appOrigin, oldFields)).toEqual({ status: 200, emits: false });
      expect(hash(JSON.stringify(await savedRow(legacyId)))).toBe(hash(JSON.stringify(resumed)));

      // Older urgent capture can exist before its inbox projection. Restoring it
      // must hold automatic replies, while the established in-app recovery runs.
      const urgentSid = `sm${randomUUID().replaceAll('-', '')}`, urgentBody = 'An older urgent household note';
      const urgentKey = `${URGENT}:${hash(JSON.stringify([familyId, 'sms', urgentSid]))}`, urgentId = receiptId(urgentKey);
      const urgentInput = { version: 1, familyId, channel: 'sms', providerRef: urgentSid, from: sender, to: phone,
        subject: null, body: urgentBody, summary: 'The original urgent summary', intent: 'urgent' };
      const seeded = await admin.from('ai_tool_calls').insert({ id: urgentId, family_id: familyId, tool_name: URGENT, actor_kind: 'system',
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
        inputs: urgentInput, outputs: { version: 1, revision: randomUUID(), phase: 'queued', notificationDone: false, drain: true,
          retryAt: null, destination: null, providerSid: null, providerStatus: null },
        state: 'reserved', attempt: 0, locked_at: null, duration_ms: null, error: null, finished_at: null,
        idempotency_key: urgentKey, resource_table: 'family_inbox_messages', resource_id: null,
      }).select('id');
      expect(!seeded.error && seeded.data?.length === 1).toBe(true);
      const urgentFields = { MessageSid: urgentSid.toUpperCase(), From: sender, To: phone, Body: urgentBody };
      const urgentBefore = await familySnapshot(familyId);
      await movePhone(familyId, otherFamily);
      expect(await callback(appOrigin, urgentFields)).toEqual({ status: 503, emits: false });
      expect(await familySnapshot(familyId)).toBe(urgentBefore); expect(await familySnapshot(otherFamily)).toBe(otherEffects);
      await movePhone(otherFamily, familyId);
      expect(await callback(appOrigin, urgentFields)).toEqual({ status: 200, emits: false });
      await noIngress(urgentSid);
      const recovered = await admin.from('family_inbox_messages').select('id,provider_ref,body,ai_summary,ai_intent,direction')
        .eq('family_id', familyId).eq('channel', 'sms').eq('provider_ref', urgentSid).single();
      expect(recovered.error).toBeNull();
      expect(recovered.data).toMatchObject({ provider_ref: urgentSid, body: urgentBody, ai_summary: urgentInput.summary, ai_intent: 'urgent', direction: 'inbound' });
      const held = await savedRow(receiptId(replyKey(familyId, urgentSid)));
      expect(held.outputs).toMatchObject({ phase: 'legacy_unknown', emissionToken: null, inboundId: recovered.data?.id });
      expect(held.inputs).toMatchObject({ candidate: { reply: null, summary: urgentInput.summary } });
      const finishedUrgent = await savedRow(urgentId);
      expect(finishedUrgent.inputs).toEqual(urgentInput);
      expect(finishedUrgent.outputs).toMatchObject({ phase: 'in_app_only', notificationDone: true, drain: false });
      const recoveredEffects = await familySnapshot(familyId);
      expect(await callback(appOrigin, urgentFields)).toEqual({ status: 200, emits: false });
      expect(await familySnapshot(familyId)).toBe(recoveredEffects); expect(await familySnapshot(otherFamily)).toBe(otherEffects);
    } finally {
      const cleanup = await Promise.allSettled(accounts.map(account => account.dispose()));
      if (cleanup.some(result => result.status === 'rejected')) throw new Error('SMS ingress E2E could not dispose both owned accounts.');
    }
  });
});
