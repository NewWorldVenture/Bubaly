// An emergency escalation stops when its caller's deadline passes.
//
// The SMS lane ran escalateGuardianEmergency under a 30-second smsStep, but
// the arrow it passed dropped the step's signal, the escalation took none, and
// sendSms/initiateCall went through a twilioFetch that gave fetch a fixed
// 15-second AbortSignal.timeout of its own. smsStep is a caller-side cut-off —
// it races the work against the deadline and moves on — so when the step timed
// out the escalation kept running detached: the remaining managers were still
// texted and called while the route had already answered 503 and Twilio was
// retrying into the escalation's own claim. And the fan-out was a sequential
// loop, two Twilio requests of up to 15 s each per manager, so a family with
// two or three managers on a slow provider could not finish inside the budget
// at all. (The WhatsApp route awaited the same fan-out with no deadline.)
//
// Now the signal is threaded end to end: smsStep's `current` signal goes into
// the escalation, from there into sendSms and initiateCall, and twilioFetch
// combines it with its 15 s ceiling (AbortSignal.any), so a send in flight is
// cut off at the deadline and no new send starts after it. Managers are fanned
// out together, so the whole fan-out is bounded by one SMS plus one call rather
// than by the number of managers. An aborted request may still have been
// accepted by Twilio, so an interrupted escalation that confirmed nobody keeps
// its claim parked as `error` (a retry inside ten minutes is a duplicate)
// instead of giving it back.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { at, between } from './helpers/source-order';

const seam = vi.hoisted(() => ({ sms: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true, sendSms: seam.sms, initiateCall: seam.call,
}));

const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const COMM = '00000000-0000-4000-8000-000000000a01';
const PHONES = ['+15550000001', '+15550000002', '+15550000003'];
const INPUT = { familyId: FAMILY, commId: COMM, escalationType: 'emergency_call', severity: 'critical', description: 'Caller says there is smoke in the kitchen.', callerNumber: '+15550000000' } as const;

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A send that stays in flight until its signal aborts, as a Twilio request on a dead link does. */
function hangsUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    // A send that was given no signal can never be cut off; fail it at once so
    // the caller's next step is what the test sees, not a timeout.
    if (!signal) return reject(new Error('the send was given no signal'));
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://guardian-fixture.invalid');
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], guardian_escalations: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  seam.sms.mockReset(); seam.call.mockReset();
  seam.sms.mockResolvedValue(undefined); seam.call.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function managers(count: number) {
  db.seed('family_members', PHONES.slice(0, count).map((_phone, i) => ({ id: `m-${i}`, family_id: FAMILY, user_id: `u-${i}`, display_name: `Manager ${i}`, role: i === 0 ? 'parent' : 'adult', is_active: true })));
  db.seed('profiles', PHONES.slice(0, count).map((phone, i) => ({ id: `u-${i}`, phone })));
}

describe('the transport takes the caller\'s signal', () => {
  // The real twilio module (past the mock above), with fetch stubbed: the
  // signal fetch is given is what decides whether a send can be cut off at all.
  async function realTwilio() {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACsynthetic'); vi.stubEnv('TWILIO_AUTH_TOKEN', 'synthetic'); vi.stubEnv('TWILIO_PHONE_NUMBER', '+15550009999');
    return vi.importActual<typeof import('@/lib/guardian/twilio')>('@/lib/guardian/twilio');
  }

  it('sendSms and initiateCall hand fetch a signal that follows the caller\'s, under the 15 s ceiling', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.signal as AbortSignal);
      return new Response(JSON.stringify({ sid: `CA${'1'.repeat(32)}` }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const { sendSms, initiateCall } = await realTwilio();
    const controller = new AbortController();
    await sendSms(PHONES[0], 'hello', { signal: controller.signal });
    await initiateCall({ to: PHONES[0], twimlUrl: 'https://guardian-fixture.invalid/twiml', signal: controller.signal });
    expect(seen).toHaveLength(2);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
    // The defect: fetch was given AbortSignal.timeout(15_000) and nothing else,
    // so the caller's abort never reached the request.
    expect(seen.every((signal) => !signal.aborted)).toBe(true);
    controller.abort();
    expect(seen.every((signal) => signal.aborted), 'the caller\'s abort reaches the request').toBe(true);
  });

  it('a send in flight is cut off when the caller aborts', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => hangsUntilAborted(init.signal as AbortSignal)));
    const { sendSms } = await realTwilio();
    const controller = new AbortController();
    const pending = sendSms(PHONES[0], 'hello', { signal: controller.signal });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled, 'still in flight while the caller waits').toBe(false);
    controller.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow();
  });

  it('without a caller signal the 15 s ceiling still applies', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.signal as AbortSignal);
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const { sendSms } = await realTwilio();
    await sendSms(PHONES[0], 'hello');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('escalateGuardianEmergency under a deadline', () => {
  it('starts no new send after the signal aborts, and parks the claim rather than giving it back', async () => {
    managers(1);
    const controller = new AbortController();
    // The text hangs on a dead link; the deadline passes while it is in flight.
    seam.sms.mockImplementation((_to: string, _body: string, options?: { signal?: AbortSignal }) => hangsUntilAborted(options?.signal));
    const { escalateGuardianEmergency } = await import('@/lib/guardian/escalate');
    const pending = escalateGuardianEmergency(client(), INPUT, { signal: controller.signal });
    await flush();
    expect(seam.sms).toHaveBeenCalledTimes(1);
    controller.abort(new Error('Guardian SMS operation unavailable'));
    const outcome = await pending;
    // The defect: the loop went on to initiateCall after the aborted text, and
    // the outcome was `undelivered` with the claim released — so the retry the
    // caller was already making re-sent to a manager whose text Twilio may
    // well have accepted.
    expect(seam.call, 'no new send starts after the deadline').not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'interrupted', notifiedCount: 0 });
    expect(db.table('guardian_escalations')).toHaveLength(1);
    expect(db.table('guardian_escalations')[0]).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false });
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ callback_type: 'emergency_escalation', status: 'error' })]);
  });

  it('an abort before any send started gives the claim back, since nothing can have reached Twilio', async () => {
    managers(1);
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    const { escalateGuardianEmergency } = await import('@/lib/guardian/escalate');
    const outcome = await escalateGuardianEmergency(client(), INPUT, { signal: controller.signal });
    expect(seam.sms).not.toHaveBeenCalled();
    expect(seam.call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'interrupted', notifiedCount: 0 });
    expect(db.table('guardian_escalations'), 'still recorded, so the retry sweep can see it').toHaveLength(1);
    expect(db.table('guardian_callback_events')).toEqual([]);
  });

  it('a manager confirmed reached before the deadline is recorded, and the escalation is delivered', async () => {
    managers(2);
    const controller = new AbortController();
    seam.sms.mockImplementation(async (to: string, _body: string, options?: { signal?: AbortSignal }) => {
      if (to === PHONES[0]) return;
      return hangsUntilAborted(options?.signal);
    });
    seam.call.mockImplementation(async (params: { to: string; signal?: AbortSignal }) => { if (params.to !== PHONES[0]) return hangsUntilAborted(params.signal); });
    const { escalateGuardianEmergency } = await import('@/lib/guardian/escalate');
    const pending = escalateGuardianEmergency(client(), INPUT, { signal: controller.signal });
    await flush();
    controller.abort(new Error('deadline'));
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'delivered', notifiedCount: 1 });
    expect(db.table('guardian_escalations')[0]).toMatchObject({ notified_member_ids: ['m-0'] });
    expect(db.table('guardian_callback_events')[0]).toMatchObject({ status: 'processed' });
  });

  it('fans the managers out together, so the budget is one text plus one call rather than that times the family', async () => {
    managers(3);
    const resolvers: Array<() => void> = [];
    seam.sms.mockImplementation(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const { escalateGuardianEmergency } = await import('@/lib/guardian/escalate');
    const pending = escalateGuardianEmergency(client(), INPUT);
    await flush();
    // The defect: one manager at a time — only the first text had been started
    // while the other two waited on it.
    expect(seam.sms).toHaveBeenCalledTimes(3);
    expect(seam.sms.mock.calls.map((call) => call[0]).sort()).toEqual([...PHONES].sort());
    for (const resolve of resolvers) resolve();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'delivered', notifiedCount: 3, smsSent: true, callAttempted: true });
    expect(seam.call).toHaveBeenCalledTimes(3);
  });

  it('passes its signal into every send', async () => {
    managers(2);
    const controller = new AbortController();
    const { escalateGuardianEmergency } = await import('@/lib/guardian/escalate');
    await escalateGuardianEmergency(client(), INPUT, { signal: controller.signal });
    for (const call of seam.sms.mock.calls) expect((call[2] as { signal?: AbortSignal }).signal).toBe(controller.signal);
    for (const call of seam.call.mock.calls) expect((call[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });
});

describe('the callers hand the escalation their deadline', () => {
  it('the SMS lane forwards the step\'s own signal, and treats a cut-off like a failed send', () => {
    const source = readFileSync('lib/guardian/sms-processing.ts', 'utf8');
    const step = source.slice(at(source, 'current => escalateGuardianEmergency('));
    expect(step.slice(0, 600)).toContain('{ signal: current }');
    expect(source).toMatch(/escalation\.kind === 'interrupted'/);
  });

  it('the WhatsApp route bounds the fan-out it awaits', () => {
    const source = readFileSync('app/api/guardian/inbound/whatsapp/route.ts', 'utf8');
    const call = source.slice(at(source, 'await escalateGuardianEmergency('));
    expect(call.slice(0, 800)).toMatch(/signal:\s*AbortSignal\.any\(\[req\.signal,\s*AbortSignal\.timeout\(/);
  });

  it('twilioFetch combines the caller\'s signal with its own ceiling instead of replacing it', () => {
    const source = readFileSync('lib/guardian/twilio.ts', 'utf8');
    const body = between(source, 'async function twilioFetch(', 'export function isTwilioConfigured');
    expect(body).toContain('signal?: AbortSignal');
    expect(body).toMatch(/AbortSignal\.any\(\[signal, AbortSignal\.timeout\(15_000\)\]\)/);
  });
});
