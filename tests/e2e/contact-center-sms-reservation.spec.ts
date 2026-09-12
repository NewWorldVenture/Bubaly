import { expect, test } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

const TOKEN = 'ci-only-guardian-signed-ingress-fixture';
function client(origin: string, key: string) {
  return createClient<Database>(origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
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
  const xml = await response.text();
  return { status: response.status, emits: xml.includes('<Message>') };
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe('Contact Center reply reservation against disposable PostgreSQL and HTTP', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires disposable local Supabase.');
  test.setTimeout(180_000);

  test('signed replay and concurrent callbacks emit once while private receipts reject child writes', async ({ baseURL }) => {
    const appOrigin = requireLocalOrigin(baseURL), origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (process.env.TWILIO_AUTH_TOKEN !== TOKEN || process.env.TWILIO_ACCOUNT_SID
      || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      throw new Error('SMS reservation E2E requires isolated synthetic configuration.');
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    if (!serviceKey || !anonKey) throw new Error('SMS reservation E2E needs disposable backend configuration.');
    const admin = client(origin, serviceKey);
    let account: OwnedAccount | undefined;
    try {
      account = await createOwnedAccount(origin, serviceKey);
      const familyId = account.familyId;
      const suffix = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 10_000_000_000n;
      const phone = `+1${suffix.toString().padStart(10, '0')}`;
      const channel = await admin.from('family_contact_channels').insert({
        family_id: familyId, phone_number: phone, ai_concierge_enabled: true,
      }).select('family_id');
      expect(!channel.error && channel.data?.length === 1, 'Create only the owned synthetic channel').toBe(true);
      const fields = { MessageSid: `SM${randomUUID().replaceAll('-', '')}`, From: '+12025550196', To: phone,
        Body: 'A special offer is available this week.' };
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: true });
      const inbox = () => admin.from('family_inbox_messages').select('*').eq('family_id', familyId).eq('channel', 'sms').order('id');
      const ledger = () => admin.from('ai_tool_calls').select('*').eq('family_id', familyId).eq('tool_name', 'contact_center.sms_reply').order('id');
      const captured = await inbox(), receipts = await ledger();
      expect(!captured.error && !receipts.error).toBe(true);
      expect(captured.data?.filter(row => row.direction === 'inbound')).toHaveLength(1);
      expect(captured.data?.filter(row => row.direction === 'outbound')).toHaveLength(1);
      expect(receipts.data).toHaveLength(1);
      expect(receipts.data![0].outputs).toMatchObject({ phase: 'emission_reserved' });
      const outgoing = captured.data!.find(row => row.direction === 'outbound')!;
      const archive = await admin.from('family_inbox_messages').update({ status: 'archived' })
        .eq('family_id', familyId).eq('id', outgoing.id).select('id');
      expect(!archive.error && archive.data?.length === 1).toBe(true);
      const archivedInbox = await inbox();
      expect(archivedInbox.error).toBeNull();
      expect(await callback(appOrigin, fields)).toEqual({ status: 200, emits: false });
      expect((await inbox()).data).toEqual(archivedInbox.data);
      expect((await ledger()).data).toEqual(receipts.data);

      const parallelFields = { ...fields, MessageSid: `SM${randomUUID().replaceAll('-', '')}` };
      const overlap = await Promise.all([callback(appOrigin, parallelFields), callback(appOrigin, parallelFields)]);
      expect(overlap.filter(result => result.emits)).toHaveLength(1);
      expect(overlap.every(result => result.status === 200 || result.status === 503)).toBe(true);
      expect(await callback(appOrigin, parallelFields)).toEqual({ status: 200, emits: false });
      const finalInbox = await inbox(), finalReceipts = await ledger();
      expect(!finalInbox.error && !finalReceipts.error).toBe(true);
      expect(finalInbox.data?.filter(row => row.direction === 'inbound')).toHaveLength(2);
      expect(finalInbox.data?.filter(row => row.direction === 'outbound')).toHaveLength(2);
      expect(finalReceipts.data).toHaveLength(2);
      for (const receipt of finalReceipts.data!) expect(receipt.outputs).toMatchObject({ phase: 'emission_reserved' });

      const role = await admin.from('family_members').update({ role: 'child' })
        .eq('family_id', familyId).eq('user_id', account.userId).select('id');
      expect(!role.error && role.data?.length === 1).toBe(true);
      const child = client(origin, anonKey);
      const signedIn = await child.auth.signInWithPassword({ email: account.email, password: account.password });
      expect(!signedIn.error && signedIn.data.user?.id === account.userId, 'Use only the owned synthetic child').toBe(true);
      const saved = finalReceipts.data![0];
      const forged = await child.from('ai_tool_calls').insert({
        id: randomUUID(), family_id: familyId, tool_name: saved.tool_name, actor_kind: 'system',
        inputs: saved.inputs, outputs: saved.outputs, state: saved.state, attempt: saved.attempt,
        idempotency_key: randomUUID(), resource_table: saved.resource_table, resource_id: saved.resource_id,
      });
      expect(forged.error?.code).toBe('42501');
      expect((await ledger()).data).toEqual(finalReceipts.data);
    } finally { if (account) await account.dispose(); }
  });
});
