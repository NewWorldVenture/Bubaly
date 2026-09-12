import { expect, test } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import { withGuardianTables } from '../../lib/supabase/guardian-tables';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

const enabled = process.env.E2E_DURABLE_SESSION === '1';
const INGRESS_TEST_TOKEN = 'ci-only-guardian-signed-ingress-fixture';
type Client = SupabaseClient<Database>;

function requireSyntheticIngress(): void {
  if (process.env.TWILIO_AUTH_TOKEN !== INGRESS_TEST_TOKEN
    || process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_PHONE_NUMBER
    || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    throw new Error('Guardian ingress E2E requires its exact synthetic token, no messaging credentials and no AI keys.');
  }
}

async function postIngress(origin: string, params: Record<string, string>, validSignature = true): Promise<number> {
  const url = `${requireLocalOrigin(origin)}/api/guardian/inbound/sms`;
  const signed = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  const signature = createHmac('sha1', validSignature ? INGRESS_TEST_TOKEN : 'invalid-disposable-signature')
    .update(signed).digest('base64');
  // Global fetch keeps auth headers out of Playwright request/trace artifacts.
  // Only the actual production-mode route can accept this external signature.
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      body: new URLSearchParams(params),
    });
    await response.arrayBuffer();
    return response.status;
  } catch { throw new Error('Guardian ingress E2E could not complete its local signed request.'); }
}

function client(origin: string, key: string): Client {
  return createClient<Database>(origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
}

async function signedIn(origin: string, key: string, account: OwnedAccount): Promise<Client> {
  const member = client(origin, key);
  try {
    const result = await member.auth.signInWithPassword({ email: account.email, password: account.password });
    if (result.error || result.data.user?.id !== account.userId || !result.data.session) throw new Error();
    return member;
  } catch { throw new Error('Guardian authority E2E could not sign in its disposable account.'); }
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.describe('Guardian receipt authority against disposable GoTrue and PostgREST', () => {
  test.skip(!enabled, 'Requires E2E_DURABLE_SESSION=1 and disposable local Supabase.');
  test.setTimeout(120_000);

  test('family members can file communications but cannot forge, edit or delete server receipts', async ({ baseURL }) => {
    requireLocalOrigin(baseURL);
    const origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!key || !serviceKey) throw new Error('Guardian authority E2E requires disposable backend configuration.');
    const owned: OwnedAccount[] = [];
    try {
      const account = await createOwnedAccount(origin, serviceKey); owned.push(account);
      const other = await createOwnedAccount(origin, serviceKey); owned.push(other);
      const admin = client(origin, serviceKey);
      const member = await signedIn(origin, key, account);
      const outsider = await signedIn(origin, key, other);
      const anonymous = client(origin, key);
      const commId = randomUUID(), receiptId = randomUUID(), attemptedId = randomUUID();
      const sid = `SM${randomUUID().replaceAll('-', '')}`;
      const guardian = withGuardianTables(member);
      // A real signed-in parent's own-family INSERT is the reason a normal
      // communication row cannot establish service decision authorship.
      const communication = await guardian.from('guardian_communications').insert({
        id: commId, family_id: account.familyId, comm_type: 'sms_inbound', direction: 'inbound',
        from_number: '+12025550111', to_number: '+12025550112', body: 'Disposable authority fixture',
        twilio_sms_sid: sid, status: 'blocked', trust_level_at_time: 'blocked', routing_mode_used: 'blocked',
        ai_decision_reason: 'Untrusted fixture decision', scam_detected: false, scam_confidence: 0,
      }).select('id');
      expect(!communication.error && communication.data?.length === 1 && communication.data[0].id === commId,
        'The fixture must demonstrate the existing communication INSERT permission').toBe(true);

      // This is a schema-valid ledger fixture, not a claim of signed ingress.
      // The application additionally validates its complete receipt contract.
      const receipt = {
        id: receiptId, family_id: account.familyId, tool_name: 'guardian.sms_intake', actor_kind: 'system' as const,
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null,
        request_id: null, conversation_id: null, message_id: null,
        inputs: { version: 1, smsSid: sid }, outputs: { fixture: 'service-authored', revision: randomUUID() },
        state: 'reserved' as const, attempt: 0, idempotency_key: `guardian-authority-fixture:${receiptId}`,
        resource_table: 'guardian_communications', resource_id: commId,
      };
      const forged = await member.from('ai_tool_calls').insert({ ...receipt, id: attemptedId });
      expect(forged.error?.code === '42501', 'Authenticated receipt INSERT must be rejected by PostgreSQL permissions').toBe(true);
      const absent = await admin.from('ai_tool_calls').select('id').eq('family_id', account.familyId).eq('id', attemptedId);
      expect(!absent.error && absent.data?.length === 0, 'Rejected receipt INSERT must leave no record').toBe(true);

      const saved = await admin.from('ai_tool_calls').insert(receipt);
      expect(!saved.error, 'The service must be able to persist its receipt').toBe(true);
      const visible = await member.from('ai_tool_calls').select('id').eq('id', receiptId);
      expect(!visible.error && visible.data?.length === 1 && visible.data[0].id === receiptId,
        'A family manager can read the owned receipt without gaining write authority').toBe(true);

      const changed = await member.from('ai_tool_calls').update({ outputs: { fixture: 'forged' }, state: 'succeeded' })
        .eq('family_id', account.familyId).eq('id', receiptId).select('id');
      expect((!changed.error && changed.data?.length === 0) || changed.error?.code === '42501',
        'A family manager must not update the receipt').toBe(true);
      const removed = await member.from('ai_tool_calls').delete().eq('family_id', account.familyId).eq('id', receiptId).select('id');
      expect((!removed.error && removed.data?.length === 0) || removed.error?.code === '42501',
        'A family manager must not delete the receipt').toBe(true);
      const unchanged = await admin.from('ai_tool_calls').select('inputs,outputs,state,resource_id')
        .eq('family_id', account.familyId).eq('id', receiptId).single();
      expect(!unchanged.error, 'The service must still read the retained receipt').toBe(true);
      expect(unchanged.data).toEqual({ inputs: receipt.inputs, outputs: receipt.outputs, state: receipt.state, resource_id: commId });

      for (const reader of [outsider, anonymous]) {
        const hidden = await reader.from('ai_tool_calls').select('id').eq('id', receiptId);
        expect((!hidden.error && hidden.data?.length === 0) || hidden.error?.code === '42501',
          'Other families and anonymous clients must not read the receipt').toBe(true);
        const denied = await reader.from('ai_tool_calls').insert({ ...receipt, id: randomUUID(), idempotency_key: randomUUID() });
        expect(denied.error?.code === '42501', 'Other families and anonymous clients must not insert receipts').toBe(true);
      }
    } finally {
      const cleanup = await Promise.allSettled(owned.map(account => account.dispose()));
      if (cleanup.some(result => result.status === 'rejected')) throw new Error('Guardian authority E2E could not remove its owned disposable fixtures.');
    }
  });

  for (const scenario of [
    { name: 'blocked', forgedMode: 'blocked', expectedMode: 'ai_handle_first', phone: '+12025550181', notifications: 1 },
    { name: 'permitted', forgedMode: 'ai_handle_first', expectedMode: 'blocked', phone: '+12025550182', notifications: 0 },
  ]) {
    test(`signed SMS replaces a member-forged ${scenario.name} decision and reuses its service receipt on retry`, async ({ baseURL }) => {
      const appOrigin = requireLocalOrigin(baseURL);
      const origin = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
      requireSyntheticIngress();
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      if (!key || !serviceKey) throw new Error('Guardian ingress E2E requires disposable backend configuration.');
      const admin = client(origin, serviceKey);
      const sid = `SM${randomUUID().replaceAll('-', '')}`;
      let account: OwnedAccount | undefined;
      try {
        account = await createOwnedAccount(origin, serviceKey);
        const familyId = account.familyId;
        const member = await signedIn(origin, key, account);
        const guardian = withGuardianTables(member);
        const members = await member.from('family_members').select('id')
          .eq('family_id', familyId).eq('user_id', account.userId).eq('is_active', true);
        expect(!members.error && members.data?.length === 1, 'Resolve exactly the owned active family member').toBe(true);
        const memberId = members.data![0].id;
        const profileId = randomUUID(), commId = randomUUID();
        const params = { SmsSid: sid, From: '+12025550189', To: scenario.phone, Body: 'We will bring the sandwiches for lunch.' };
        const profile = await guardian.from('guardian_member_profiles').insert({
          id: profileId, family_id: familyId, member_id: memberId, guardian_phone: params.To,
          default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring',
          default_mode_trusted: 'immediate_ring', default_mode_known: 'ai_handle_first',
          default_mode_unknown: scenario.expectedMode, default_mode_suspected_spam: 'silent_handling',
          default_mode_blocked: 'blocked', context_overrides: {}, ai_persona_name: 'Disposable Guardian',
          ai_greeting_template: null, emergency_always_ring: true, voicemail_greeting: null,
          current_context: 'normal', is_active: true,
        }).select('id');
        expect(!profile.error && profile.data?.length === 1, 'Persist the owned family routing profile').toBe(true);
        const forged = {
          id: commId, family_id: familyId, member_id: memberId, comm_type: 'sms_inbound', direction: 'inbound',
          from_number: params.From, to_number: params.To, body: params.Body, twilio_sms_sid: sid,
          status: scenario.forgedMode === 'blocked' ? 'blocked' : 'received',
          contact_id: null, from_name: null, trust_level_at_time: scenario.forgedMode === 'blocked' ? 'blocked' : 'unknown',
          routing_mode_used: scenario.forgedMode, routing_rule_id: null, ai_decision_reason: 'Member-forged disposable decision',
          scam_detected: false, scam_type: null, scam_confidence: 0,
        };
        const inserted = await guardian.from('guardian_communications').insert(forged).select('id');
        expect(!inserted.error && inserted.data?.length === 1, 'File the exact inbound identity through real member permissions').toBe(true);
        const communication = () => withGuardianTables(admin).from('guardian_communications').select('*')
          .eq('family_id', familyId).eq('member_id', memberId).eq('id', commId).eq('twilio_sms_sid', sid).single();
        const receipts = () => admin.from('ai_tool_calls').select('*')
          .eq('family_id', familyId).eq('tool_name', 'guardian.sms_intake').eq('resource_id', commId);
        const events = () => admin.from('guardian_callback_events').select('*').eq('event_id', sid).eq('callback_type', 'inbound_sms');
        const notifications = () => admin.from('notifications').select('id,user_id,body,sent_at,pushed_at')
          .eq('family_id', familyId).eq('related_type', 'guardian_communications').eq('related_id', commId).order('id');

        const before = await communication();
        expect(!before.error && !!before.data, 'Read the exact forged communication before ingress').toBe(true);
        expect(await postIngress(appOrigin, params, false), 'Production ingress must reject an invalid signature').toBe(401);
        const [rejectedCommunication, rejectedReceipts, rejectedEvents, rejectedNotifications] = await Promise.all([
          communication(), receipts(), events(), notifications(),
        ]);
        expect(!rejectedCommunication.error && !rejectedReceipts.error && !rejectedEvents.error && !rejectedNotifications.error).toBe(true);
        expect(rejectedCommunication.data).toEqual(before.data);
        expect(rejectedReceipts.data).toEqual([]);
        expect(rejectedEvents.data).toEqual([]);
        expect(rejectedNotifications.data).toEqual([]);

        expect(await postIngress(appOrigin, params), 'The signed request must complete actual intake').toBe(200);
        const [savedCommunication, savedReceipts, savedEvents, savedNotifications] = await Promise.all([
          communication(), receipts(), events(), notifications(),
        ]);
        expect(!savedCommunication.error && !savedReceipts.error && !savedEvents.error && !savedNotifications.error).toBe(true);
        expect(savedCommunication.data).toMatchObject({
          ...forged, status: 'received', trust_level_at_time: 'unknown', routing_mode_used: scenario.expectedMode,
          ai_decision_reason: expect.any(String),
        });
        const decision = savedCommunication.data as unknown as {
          status: string; contact_id: null; from_name: null; trust_level_at_time: string; routing_mode_used: string;
          routing_rule_id: null; ai_decision_reason: string; scam_detected: boolean; scam_type: null; scam_confidence: number;
        };
        expect(decision.ai_decision_reason).not.toBe(forged.ai_decision_reason);
        expect(decision.ai_decision_reason.length).toBeGreaterThan(0);
        expect(savedReceipts.data).toHaveLength(1);
        const receipt = savedReceipts.data![0];
        expect(receipt).toMatchObject({
          family_id: familyId, tool_name: 'guardian.sms_intake', actor_kind: 'system', state: 'succeeded', attempt: 1,
          requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null,
          request_id: null, conversation_id: null, message_id: null, locked_at: null, duration_ms: null, error: null,
          resource_table: 'guardian_communications', resource_id: commId,
          idempotency_key: `guardian.sms_intake:v1:${sid.toLowerCase()}`,
          inputs: { version: 1, communicationId: commId, smsSid: sid, familyId, memberId, from: params.From, to: params.To, body: params.Body },
        });
        expect(Number.isFinite(Date.parse(receipt.finished_at ?? ''))).toBe(true);
        expect(receipt.outputs).toEqual({
          version: 1, revision: expect.stringMatching(/^[0-9a-f-]{36}$/i), phase: 'decided',
          decision: {
            status: decision.status, contact_id: decision.contact_id, from_name: decision.from_name,
            trust_level_at_time: decision.trust_level_at_time, routing_mode_used: decision.routing_mode_used,
            routing_rule_id: decision.routing_rule_id, ai_decision_reason: decision.ai_decision_reason,
            scam_detected: decision.scam_detected, scam_type: decision.scam_type, scam_confidence: decision.scam_confidence,
          },
        });
        expect(savedEvents.data).toHaveLength(1);
        const event = savedEvents.data![0];
        expect(event).toMatchObject({ event_id: sid, callback_type: 'inbound_sms', status: 'processed', error: null });
        expect(Number.isFinite(Date.parse(event.processed_at ?? ''))).toBe(true);
        expect(savedNotifications.data).toHaveLength(scenario.notifications);
        if (scenario.notifications) expect(savedNotifications.data![0]).toMatchObject({ user_id: null, body: params.Body, sent_at: null, pushed_at: null });

        // Change the real policy, then make only this processed event claimable.
        // Leaving it processed would exercise only the outer idempotency shortcut.
        const changedProfile = await guardian.from('guardian_member_profiles').update({ default_mode_unknown: scenario.forgedMode })
          .eq('id', profileId).eq('family_id', familyId).eq('member_id', memberId)
          .eq('default_mode_unknown', scenario.expectedMode).select('id,default_mode_unknown');
        expect(!changedProfile.error && changedProfile.data?.length === 1).toBe(true);
        expect(changedProfile.data![0]).toMatchObject({ id: profileId, default_mode_unknown: scenario.forgedMode });
        const reset = await admin.from('guardian_callback_events').update({ status: 'error', processed_at: null, error: null })
          .eq('event_id', sid).eq('callback_type', 'inbound_sms').eq('status', 'processed')
          .eq('received_at', event.received_at).eq('processed_at', event.processed_at!).is('error', null).select('*');
        expect(!reset.error && reset.data?.length === 1, 'Reset only the exact completed fixture event').toBe(true);
        expect(reset.data![0]).toMatchObject({ event_id: sid, callback_type: 'inbound_sms', status: 'error', processed_at: null, error: null });
        expect(await postIngress(appOrigin, params), 'A claimable retry must reuse the trusted receipt').toBe(200);
        const [retryCommunication, retryReceipts, retryEvents, retryNotifications] = await Promise.all([
          communication(), receipts(), events(), notifications(),
        ]);
        expect(!retryCommunication.error && !retryReceipts.error && !retryEvents.error && !retryNotifications.error).toBe(true);
        expect(retryCommunication.data).toEqual(savedCommunication.data);
        expect(retryReceipts.data).toEqual(savedReceipts.data);
        expect(retryNotifications.data).toEqual(savedNotifications.data);
        expect(retryEvents.data).toHaveLength(1);
        expect(retryEvents.data![0]).toMatchObject({ event_id: sid, callback_type: 'inbound_sms', status: 'processed', error: null });
        expect(Number.isFinite(Date.parse(retryEvents.data![0].processed_at ?? ''))).toBe(true);
      } finally {
        // Callback events have no family FK; delete only our random SID/type.
        // Always attempt family/Auth cleanup even if that separate deletion fails.
        const cleanup = await Promise.allSettled([
          Promise.resolve(admin.from('guardian_callback_events').delete().eq('event_id', sid).eq('callback_type', 'inbound_sms'))
            .then(result => { if (result.error) throw new Error('Owned callback cleanup failed'); }),
          ...(account ? [account.dispose()] : []),
        ]);
        if (cleanup.some(result => result.status === 'rejected')) throw new Error('Guardian ingress E2E could not remove its owned disposable fixtures.');
      }
    });
  }
});
