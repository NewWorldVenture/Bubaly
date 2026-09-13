import { expect, test } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { withGuardianTables } from '../../lib/supabase/guardian-tables';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

const INGRESS_TOKEN = 'ci-only-guardian-signed-ingress-fixture';
const CRON_TOKEN = 'ci-only-guardian-recovery-fixture';

function requireSyntheticConfiguration() {
  if (process.env.TWILIO_AUTH_TOKEN !== INGRESS_TOKEN || process.env.CRON_SECRET !== CRON_TOKEN
    || process.env.TWILIO_ACCOUNT_SID || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    throw new Error('Guardian recovery E2E requires isolated synthetic configuration.');
  }
}
function client(origin: string, key: string) {
  return createClient<Database>(origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
}
async function callback(origin: string, params: Record<string, string>) {
  const url = `${origin}/api/guardian/inbound/sms`;
  const signed = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  const signature = createHmac('sha1', INGRESS_TOKEN).update(signed).digest('base64');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(40_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params),
  });
  await response.arrayBuffer();
  return response.status;
}
async function recover(origin: string, token = CRON_TOKEN) {
  const response = await fetch(`${origin}/api/cron/guardian-sms-recovery`, {
    redirect: 'error', signal: AbortSignal.timeout(100_000), headers: { authorization: `Bearer ${token}` },
  });
  await response.arrayBuffer();
  return response.status;
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe('Guardian autonomous SMS recovery against disposable PostgreSQL and HTTP', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires disposable local Supabase.');
  test.setTimeout(180_000);

  test('one signed intake survives a policy failure and cron alone completes it once', async ({ baseURL }) => {
    const appOrigin = requireLocalOrigin(baseURL), origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    requireSyntheticConfiguration();
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    if (!serviceKey || !anonKey) throw new Error('Guardian recovery E2E needs disposable backend configuration.');
    const admin = client(origin, serviceKey), guardian = withGuardianTables(admin);
    const sid = `SM${randomUUID().replaceAll('-', '')}`, untrustedSid = `SM${randomUUID().replaceAll('-', '')}`;
    let account: OwnedAccount | undefined;
    try {
      account = await createOwnedAccount(origin, serviceKey);
      const familyId = account.familyId;
      const members = await admin.from('family_members').select('id').eq('family_id', familyId).eq('user_id', account.userId).eq('is_active', true);
      expect(!members.error && members.data?.length === 1, 'Resolve the owned active family member').toBe(true);
      const memberId = members.data![0].id, profileId = randomUUID();
      const params = { SmsSid: sid, From: '+12025550193', To: '+12025550194', Body: 'We will bring the picnic sandwiches tomorrow.' };
      const profile = await guardian.from('guardian_member_profiles').insert({
        id: profileId, family_id: familyId, member_id: memberId, guardian_phone: params.To, is_active: true,
        ai_persona_name: 'Disposable Guardian', ai_greeting_template: null, voicemail_greeting: null,
        current_context: 'normal', context_overrides: { normal: 'invalid-routing-fixture' },
        default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ring',
        default_mode_known: 'ai_handle_first', default_mode_unknown: 'ai_handle_first',
        default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
      }).select('id');
      expect(!profile.error && profile.data?.length === 1, 'Persist a profile whose JSON policy is initially invalid').toBe(true);
      expect(await callback(appOrigin, params), 'The only provider callback must retain input and reject unavailable policy').toBe(503);
      const comm = () => guardian.from('guardian_communications').select('*').eq('family_id', familyId).eq('twilio_sms_sid', sid).single();
      const receipts = () => admin.from('ai_tool_calls').select('*').eq('family_id', familyId).eq('tool_name', 'guardian.sms_intake');
      const events = () => admin.from('guardian_callback_events').select('*').eq('event_id', sid).eq('callback_type', 'inbound_sms').single();
      const pendingComm = await comm(), pendingReceipts = await receipts(), pendingEvent = await events();
      expect(!pendingComm.error && !pendingReceipts.error && !pendingEvent.error).toBe(true);
      expect(pendingComm.data).toMatchObject({ family_id: familyId, member_id: memberId, body: params.Body, status: 'screening' });
      expect(pendingReceipts.data).toHaveLength(1);
      expect(pendingReceipts.data![0].outputs).toMatchObject({ phase: 'captured', decision: null });
      expect(pendingEvent.data).toMatchObject({ status: 'error', processed_at: null });
      const commId = pendingComm.data!.id;
      const notifications = () => admin.from('notifications').select('*').eq('family_id', familyId).eq('related_id', commId).order('id');

      // A child may file an ordinary communication; that never authorizes recovery.
      const childRole = await admin.from('family_members').update({ role: 'child' }).eq('id', memberId).eq('family_id', familyId).select('id');
      expect(!childRole.error && childRole.data?.length === 1).toBe(true);
      const child = client(origin, anonKey);
      const login = await child.auth.signInWithPassword({ email: account.email, password: account.password });
      expect(!login.error && login.data.user?.id === account.userId, 'Sign in only the owned synthetic child account').toBe(true);
      const untrustedId = randomUUID();
      const untrusted = await withGuardianTables(child).from('guardian_communications').insert({
        id: untrustedId, family_id: familyId, member_id: memberId, comm_type: 'sms_inbound', direction: 'inbound',
        from_number: params.From, to_number: params.To, body: 'Unverified member-written message',
        twilio_sms_sid: untrustedSid, status: 'screening',
      }).select('id');
      expect(!untrusted.error && untrusted.data?.length === 1, 'Demonstrate the ordinary member communication write').toBe(true);
      const captured = pendingReceipts.data![0];
      const forged = await child.from('ai_tool_calls').insert({
        id: randomUUID(), family_id: familyId, tool_name: captured.tool_name, actor_kind: 'system',
        inputs: captured.inputs, outputs: captured.outputs, state: captured.state, attempt: captured.attempt,
        idempotency_key: randomUUID(), resource_table: captured.resource_table, resource_id: untrustedId,
      });
      expect(forged.error?.code, 'A child cannot create the recovery authority').toBe('42501');

      expect(await recover(appOrigin, 'invalid-fixture-token'), 'Cron rejects invalid authority').toBe(401);
      expect((await comm()).data).toEqual(pendingComm.data);
      const healthy = await guardian.from('guardian_member_profiles').update({ context_overrides: {} })
        .eq('id', profileId).eq('family_id', familyId).select('id');
      expect(!healthy.error && healthy.data?.length === 1).toBe(true);
      // No second callback. The authenticated internal route is the only recovery trigger.
      // Parallel signed-ingress fixtures can remove their own queued rows while
      // this global worker scans. Their aggregate 503 does not establish our
      // outcome; the exact owned effects below must still all be complete.
      expect([200, 503], 'Cron must return its authenticated processing result').toContain(await recover(appOrigin));
      const doneComm = await comm(), doneReceipts = await receipts(), doneEvent = await events(), doneNotifications = await notifications();
      expect(!doneComm.error && !doneReceipts.error && !doneEvent.error && !doneNotifications.error).toBe(true);
      expect(doneComm.data).toMatchObject({ id: commId, family_id: familyId, member_id: memberId, body: params.Body, status: 'received', routing_mode_used: 'ai_handle_first' });
      expect(doneReceipts.data).toHaveLength(1);
      expect(doneReceipts.data![0]).toMatchObject({ resource_id: commId, outputs: { phase: 'completed' } });
      expect(doneEvent.data).toMatchObject({ status: 'processed', error: null });
      expect(doneNotifications.data).toHaveLength(1);
      expect(doneNotifications.data![0]).toMatchObject({ user_id: null, body: params.Body, related_type: 'guardian_communications', related_id: commId });

      // Require a clean completed sweep once concurrent fixture cleanup settles.
      // This also exercises PostgreSQL's lower-and-upper cursor expression;
      // repeatedly accepting 503 could hide a malformed continuation query.
      await expect.poll(() => recover(appOrigin), {
        timeout: 30_000, intervals: [500, 1000, 2000],
        message: 'A later scheduled tick must complete a clean sweep',
      }).toBe(200);
      expect((await comm()).data).toEqual(doneComm.data);
      expect((await receipts()).data).toEqual(doneReceipts.data);
      expect((await notifications()).data).toEqual(doneNotifications.data);
      const untouched = await guardian.from('guardian_communications').select('id,status,body').eq('id', untrustedId).eq('family_id', familyId).single();
      expect(!untouched.error).toBe(true);
      expect(untouched.data).toEqual({ id: untrustedId, status: 'screening', body: 'Unverified member-written message' });
      const noAuthority = await admin.from('ai_tool_calls').select('id').eq('family_id', familyId).eq('resource_id', untrustedId);
      expect(!noAuthority.error && noAuthority.data?.length === 0).toBe(true);
    } finally {
      const cleanup = await Promise.allSettled([
        Promise.resolve(admin.from('guardian_callback_events').delete().eq('event_id', sid).eq('callback_type', 'inbound_sms'))
          .then(result => { if (result.error) throw new Error('Owned callback cleanup failed'); }),
        ...(account ? [account.dispose()] : []),
      ]);
      if (cleanup.some(result => result.status === 'rejected')) throw new Error('Guardian recovery E2E could not remove its owned fixtures.');
    }
  });
});
