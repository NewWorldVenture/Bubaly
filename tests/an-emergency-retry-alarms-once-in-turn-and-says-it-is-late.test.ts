// An emergency that reached nobody is retried by the Guardian recovery cron —
// once per manager, whichever way the retry comes, in turn with the others
// waiting, and saying how late it is.
//
// The retry sweep (lib/guardian/escalation-retry.ts) re-attempts escalations
// whose record says no manager was reached. Five ways it still went wrong:
//
//  1. A WhatsApp emergency redelivered after the ten-minute reclaim window (a
//     provider redelivery, or a replay of the signed request) could not record
//     its message a second time — the unique sid refused it — so it was keyed
//     on its text instead of on its communication, took a NEW claim, and texted
//     and called every manager again, whether or not the sweep already had.
//     The reverse switch (first delivery unrecorded, a late one recorded) did
//     the same.
//  2. When the escalation's record could not be written either, the WhatsApp
//     route parked a callback nothing sweeps and the screening route only
//     logged: the manager text and call were never tried again.
//  3. A sweep attempt that reached a manager but could not update the record
//     left it reading "nobody reached"; ten minutes on, the next tick texted
//     and called every manager again.
//  4. Oldest first, ten at a time, nothing remembered: ten older records that
//     kept failing took every slot on every tick, and a newer emergency behind
//     them waited out its day.
//  5. A retry can land hours after the emergency — the job's only guaranteed
//     run is daily — and read exactly like an emergency happening now.
//
// And two the first fixes left:
//
//  6. The fix for 1 joined a later delivery to an earlier escalation keyed on
//     the same TEXT, so a different message in the same words from the same
//     caller was joined to it, found settled, and silenced: no text, no call,
//     no family notice. Only the message's own sid decides "the same message"
//     now, by a mark written under it when it is escalated under its text.
//  7. The mark an attempt leaves when its alerts went out and its record did
//     not (3) was honoured by the sweep only. The claim it marks was
//     reclaimable after ten minutes like any other `error`, so a late
//     redelivery texted and called every manager again. It is final now.
//
// And three after those:
//
//  8. A late WhatsApp delivery chose its identity from reads that FAILED: a
//     communication it could not read back left it keyed on its text, and a
//     mark it could not read was taken for "no mark" and switched a message
//     escalated under its text to its communication. Either way a new claim
//     was taken and every manager texted and called again. Neither read is
//     guessed now: the callback is given back for a retry.
//  9. A screened emergency whose escalation could not run at all — its claim
//     not taken, or the managers or their phones not read — wrote no record
//     and no work item, and the after() task only logged it. Nothing retried
//     it. The route leaves the work item now.
// 10. The work items were landed oldest first, ten at a time, with nothing to
//     move past ones that could not be landed: ten of those took every slot
//     on every tick, and a newer one behind them was never landed.
//
// Everything here goes through the real callers: the WhatsApp and screening
// webhooks, and the recovery cron route the dispatcher calls.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';
import { guardianEscalationEventId, guardianEscalationRecordId, guardianEscalationStableId } from '@/lib/guardian/escalation';

const seam = vi.hoisted(() => ({
  service: vi.fn(), scam: vi.fn(), notify: vi.fn(), turn: vi.fn(), after: vi.fn(),
  telephony: { down: false, failFor: new Set<string>() },
  sent: [] as string[], called: [] as string[], texts: [] as string[], calls: [] as string[],
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('next/server', async (original) => ({
  ...await original<typeof import('next/server')>(),
  after: (task: () => Promise<void>) => seam.after(task),
}));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/guardian/ai-screen', () => ({ screeningTurn: seam.turn, summarizeScreening: async () => 'Caller says grandpa collapsed.' }));
// Telephony that can be down (a Twilio 5xx), or refuse one number every time;
// what went out is recorded — the number, the text, and the call's TwiML URL.
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: async (to: string, body: string) => {
    if (seam.telephony.down || seam.telephony.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.sent.push(to); seam.texts.push(body);
  },
  initiateCall: async ({ to, twimlUrl }: { to: string; twimlUrl: string }) => {
    if (seam.telephony.down || seam.telephony.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.called.push(to); seam.calls.push(twimlUrl);
  },
}));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const CRON = 'synthetic-recovery-cron-secret';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const COMM = '66666666-6666-4666-8666-666666666666';
const GUARDIAN = '+15555550100';
const CALLER = '+15555550199';
const PARENT_PHONE = '+15550000777';
const EMERGENCY = 'help me, there was an accident, call 911';
const WA_SID = `SM${'d'.repeat(32)}`;
const CALL = `CA${'c'.repeat(32)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;

let db: InMemorySupabase;
const escalations = () => db.table('guardian_escalations');
const communications = () => db.table('guardian_communications');
const callback = (eventId: string) => db.table('guardian_callback_events').find((row) => row.event_id === eventId);
const owedItems = () => db.table('ai_tool_calls').filter((row) => row.tool_name === 'guardian.escalation_owed');

// ── Storage that fails on purpose ────────────────────────────────────────────
type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
const REFUSED = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
const faults: Array<{ table: string; op: Op; times: number }> = [];
/** The next `times` statements of this kind on this table resolve refused, as a timed-out PostgREST statement does. */
function fail(table: string, op: Op, times = Number.POSITIVE_INFINITY) { faults.push({ table, op, times }); }
const lostAnswers: Array<{ table: string; times: number }> = [];
/** The next `times` inserts on this table commit, and answer refused anyway. */
function loseAnswer(table: string, times = 1) { lostAnswers.push({ table, times }); }
const refusedRows: Array<{ table: string; when: (row: Row) => boolean }> = [];
/** Every insert of a row like this into this table is refused, however often it is tried: a row the database will never take. */
function refuseInsertsWhere(table: string, when: (row: Row) => boolean) { refusedRows.push({ table, when }); }
function heal() { faults.length = 0; lostAnswers.length = 0; refusedRows.length = 0; }
function refusedChain(): unknown {
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(REFUSED).then(resolve, reject);
      return () => chain;
    },
  });
  return chain;
}

function signed(path: string, form: Record<string, string>, query = ''): NextRequest {
  const url = `${ORIGIN}${path}${query}`;
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(form).toString() });
}
async function whatsapp(smsSid = WA_SID, body = EMERGENCY) {
  const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
  return POST(signed('/api/guardian/inbound/whatsapp', { SmsSid: smsSid, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: body }));
}
/** One run of the Guardian recovery cron, as the dispatcher calls it. */
async function tick() {
  const { GET } = await import('@/app/api/cron/guardian-sms-recovery/route');
  const res = await GET(new NextRequest(`${ORIGIN}/api/cron/guardian-sms-recovery`, { headers: { authorization: `Bearer ${CRON}` } }));
  return { status: res.status, body: await res.json() as { ok: boolean; escalations: Record<string, number> } };
}
/** Move a claim's clock back, as the ten minutes passing would. */
function age(eventId: string, ms: number) {
  const row = callback(eventId);
  if (!row) throw new Error(`no claim ${eventId}`);
  row.received_at = new Date(Date.parse(String(row.received_at)) - ms).toISOString();
}
const commKey = () => guardianEscalationEventId({ familyId: FAMILY, commId: communications()[0].id as string, escalationType: 'urgent_personal', severity: 'critical', description: '' });
const byContent = { familyId: FAMILY, escalationType: 'urgent_personal' as const, severity: 'critical' as const, description: `Emergency WhatsApp from (555) 555-0199: "${EMERGENCY}"`, callerNumber: CALLER };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN); vi.stubEnv('CRON_SECRET', CRON);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  seam.sent.length = 0; seam.called.length = 0; seam.texts.length = 0; seam.calls.length = 0;
  seam.telephony.down = false; seam.telephony.failFor.clear();
  seam.after.mockReset();
  seam.after.mockImplementation(() => { throw new Error('`after` was called outside a request scope.'); });
  heal();
  db = createInMemorySupabase({
    uniques: {
      guardian_callback_events: [['event_id']], notifications: [['id']], guardian_escalations: [['id']],
      guardian_communications: [['twilio_sms_sid']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], app_settings: [['key']],
    },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null }, guardian_escalations: { acknowledged_at: null } },
  });
  // The columns the migrations default to now() (escalated_at, 01370;
  // received_at, 0181) are stamped when a row is first written — and only
  // then, so an upsert of an existing record keeps its original time, as
  // Postgres does. Then the faults asked for above.
  const realFrom = db.from.bind(db);
  db.from = ((table: string) => {
    const query = realFrom(table) as unknown as Record<Op, (...args: unknown[]) => unknown>;
    const stampColumn = table === 'guardian_escalations' ? 'escalated_at' : table === 'guardian_callback_events' ? 'received_at' : null;
    if (stampColumn) {
      for (const op of ['insert', 'upsert'] as const) {
        const write = query[op].bind(query);
        query[op] = (rows: unknown, ...rest: unknown[]) => write((Array.isArray(rows) ? rows : [rows]).map((row: Row) => (
          db.table(table).some((existing) => existing.id !== undefined && existing.id === row.id) ? row : { [stampColumn]: new Date().toISOString(), ...row }
        )), ...rest);
      }
    }
    let wrote = false;
    for (const op of ['select', 'insert', 'update', 'upsert', 'delete'] as const) {
      const real = query[op].bind(query);
      query[op] = (...args: unknown[]) => {
        if (op !== 'select') wrote = true;
        const fault = (op !== 'select' || !wrote) ? faults.find((f) => f.table === table && f.op === op && f.times > 0) : undefined;
        if (fault) { fault.times -= 1; return refusedChain(); }
        if (op === 'insert' && refusedRows.some((refused) => refused.table === table && (Array.isArray(args[0]) ? args[0] : [args[0]]).some((row) => refused.when(row as Row)))) return refusedChain();
        // A write that commits and whose answer is lost on the way back.
        const lost = op === 'insert' ? lostAnswers.find((f) => f.table === table && f.times > 0) : undefined;
        if (lost) {
          lost.times -= 1;
          const committed = real(...args) as PromiseLike<unknown>;
          const chain: Record<string | symbol, unknown> = new Proxy({}, {
            get(_target, prop) {
              if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(committed).then(() => REFUSED).then(resolve, reject);
              return () => chain;
            },
          });
          return chain;
        }
        return real(...args);
      };
    }
    return query;
  }) as InMemorySupabase['from'];
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'America/Los_Angeles' }]);
  db.seed('family_members', [
    { id: CHILD, family_id: FAMILY, user_id: 'u-child', display_name: 'Kid', phone: '+15550000001', is_active: true, role: 'child' },
    { id: PARENT, family_id: FAMILY, user_id: 'u-parent', display_name: 'Ada', is_active: true, role: 'parent' },
  ]);
  db.seed('profiles', [{ id: 'u-parent', phone: PARENT_PHONE }, { id: 'u-child', phone: '+15550000001' }]);
  db.seed('guardian_member_profiles', [{
    id: PROFILE, family_id: FAMILY, member_id: CHILD, guardian_phone: GUARDIAN, is_active: true,
    ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
    emergency_always_ring: true,
  }]);
  seam.service.mockImplementation(() => db);
  seam.scam.mockReset(); seam.notify.mockReset(); seam.turn.mockReset();
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('a WhatsApp emergency delivered again after the ten-minute reclaim window', () => {
  it('after the sweep has reached the manager: acknowledged, and nobody is texted, called or told twice', async () => {
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    expect(callback(WA_SID)).toMatchObject({ status: 'error' });
    const comm = communications()[0].id;
    expect(escalations()).toEqual([expect.objectContaining({ communication_id: comm, notified_member_ids: [] })]);

    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);

    // The provider (or a replay of the signed request) delivers it again,
    // after the inbound claim can be reclaimed.
    age(WA_SID, 11 * MIN);
    const late = await whatsapp();
    // The defect: the message could not be recorded twice, so the escalation
    // was keyed on its text, took a new claim, and texted and called the
    // parent a second time, with a second record (communication_id null).
    expect(late.status).toBe(200);
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ communication_id: comm, notified_member_ids: [PARENT] });
    expect(communications()).toHaveLength(1);
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
    expect(callback(commKey())).toMatchObject({ status: 'processed' });
    // The family notice of the redelivery names the same communication, said
    // at most once per communication: notify() drops it as already said.
    expect(seam.notify).toHaveBeenCalledTimes(2);
    for (const [, input] of seam.notify.mock.calls) expect(input).toMatchObject({ relatedId: comm, once: true, urgent: true });
    // Nothing is left for the sweep.
    expect((await tick()).body.escalations).toMatchObject({ examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('with the sweep still to run: the redelivery and the sweep alarm once between them', async () => {
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    seam.telephony.down = false;
    age(WA_SID, 11 * MIN);
    // The redelivery joins the first delivery's escalation (its claim was
    // given back when nobody was reached) and reaches the parent.
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    // The defect: the sweep then retried the communication-keyed record, which
    // still said nobody was reached, and texted and called again.
    expect((await tick()).body.escalations).toMatchObject({ examined: 0, delivered: 0 });
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toEqual([expect.objectContaining({ notified_member_ids: [PARENT] })]);
  });

  it('whose first delivery could not record the message: a late one that does record it joins the first escalation', async () => {
    // The first delivery's communication insert is refused, so its escalation
    // is keyed on the message text.
    fail('guardian_communications', 'insert', 1);
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    expect(communications()).toEqual([]);
    expect(escalations()).toEqual([expect.objectContaining({ id: guardianEscalationRecordId(byContent), communication_id: null, notified_member_ids: [] })]);
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);

    age(WA_SID, 11 * MIN);
    // The defect, the other way round: the late delivery recorded the message,
    // keyed the escalation on the new communication, and alarmed again.
    expect((await whatsapp()).status).toBe(200);
    expect(communications()).toHaveLength(1);
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    // The family was told by the first delivery; the second does not say it again.
    expect(seam.notify).toHaveBeenCalledOnce();
  });

  it('whose first delivery recorded the message but never heard so: the late one finds the row and still joins the first escalation', async () => {
    // The insert commits and its answer is lost, so the first delivery keys
    // the escalation on the text; the late one learns the communication from
    // the unique sid — and must not switch to it.
    loseAnswer('guardian_communications');
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    expect(communications()).toHaveLength(1);
    expect(escalations()).toEqual([expect.objectContaining({ id: guardianEscalationRecordId(byContent), communication_id: null })]);
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ delivered: 1 });
    age(WA_SID, 11 * MIN);
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    expect(seam.notify).toHaveBeenCalledOnce();
  });
});

describe('a different WhatsApp message with the same words as one escalated under its text', () => {
  const FIRST = `SM${'a'.repeat(32)}`;
  const SECOND = `SM${'b'.repeat(32)}`;
  const markOf = (smsSid: string) => db.table('ai_tool_calls').find((row) => row.tool_name === 'guardian.whatsapp_escalation_key' && row.idempotency_key === `guardian.whatsapp_escalation_key:v1:${smsSid}`);

  it('is its own emergency: texted, called and told, while the first message\'s redelivery still joins its own escalation', async () => {
    // The first message could not be recorded, so it is escalated under its
    // text — and that is written down under ITS sid. Nobody could be reached;
    // the sweep reaches the parent.
    fail('guardian_communications', 'insert', 1);
    seam.telephony.down = true;
    expect((await whatsapp(FIRST)).status).toBe(503);
    expect(communications()).toEqual([]);
    expect(escalations()).toEqual([expect.objectContaining({ id: guardianEscalationRecordId(byContent), communication_id: null })]);
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.notify).toHaveBeenCalledOnce();

    // Later, a DIFFERENT message — its own sid — from the same caller, in the
    // same words, and this one is recorded. The defect: it was taken for the
    // first message because the text matched, joined to that settled
    // escalation, and nobody was texted, called or told.
    expect((await whatsapp(SECOND)).status).toBe(200);
    const comm = communications().find((row) => row.twilio_sms_sid === SECOND)?.id;
    expect(comm).toEqual(expect.any(String));
    expect(seam.sent, 'the second emergency texts the parent').toEqual([PARENT_PHONE, PARENT_PHONE]);
    expect(seam.called, 'and calls them').toEqual([PARENT_PHONE, PARENT_PHONE]);
    expect(seam.notify, 'and tells the family').toHaveBeenCalledTimes(2);
    expect(seam.notify.mock.calls[1][1]).toMatchObject({ relatedId: comm, once: true, urgent: true });
    expect(escalations()).toHaveLength(2);
    expect(escalations().find((row) => row.communication_id === comm)).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(callback(SECOND)).toMatchObject({ status: 'processed' });
    // What told them apart: the first message's sid carries the mark of its
    // text-keyed escalation; the second, keyed on its communication, has none.
    expect(markOf(FIRST)).toMatchObject({ family_id: FAMILY, resource_id: guardianEscalationRecordId(byContent) });
    expect(markOf(SECOND)).toBeUndefined();

    // The first message, redelivered after the ten minutes and recorded now,
    // is still the first emergency: its sid's mark joins it to its own
    // escalation, and nobody is alarmed or told again.
    age(FIRST, 11 * MIN);
    expect((await whatsapp(FIRST)).status).toBe(200);
    expect(communications()).toHaveLength(2);
    expect(seam.sent).toEqual([PARENT_PHONE, PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE, PARENT_PHONE]);
    expect(seam.notify).toHaveBeenCalledTimes(2);
    expect(escalations()).toHaveLength(2);
  });

  it('LIMIT, pinned: when NEITHER message could be recorded, the second shares the first one\'s text-keyed escalation — told in-app, not texted or called', async () => {
    // Both are keyed on the same text, and the record a text-keyed escalation
    // writes cannot say which message it came from (the retry sweep rebuilds
    // the key from that record), so the second finds the first one's claim
    // settled. Closing this needs the record to name its source message
    // (guardian_escalations.source_event_id, a migration). Until then the
    // family still gets the second message's urgent in-app notice.
    fail('guardian_communications', 'insert', 2);
    expect((await whatsapp(FIRST)).status).toBe(200);
    expect((await whatsapp(SECOND)).status).toBe(200);
    expect(communications()).toEqual([]);
    expect(escalations()).toHaveLength(1);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(seam.notify).toHaveBeenCalledTimes(2);
    expect(seam.notify.mock.calls[1][1]).toMatchObject({ relatedId: null, urgent: true });
    // Each under its own sid, so a redelivery of either still joins only its own.
    expect(markOf(FIRST)).toBeDefined();
    expect(markOf(SECOND)).toBeDefined();
  });

  it('LIMIT, pinned: a message escalated under its text whose mark was refused too is, redelivered late and recorded, keyed on its communication', async () => {
    // Three failures in a row: the message not recorded, its mark not written,
    // and nobody reached at first. The late redelivery then cannot know the
    // text-keyed escalation was this message's, and alarms a second time —
    // rather than, as before, joining whatever escalation had the same words.
    fail('guardian_communications', 'insert', 1);
    fail('ai_tool_calls', 'insert', 1);
    seam.telephony.down = true;
    expect((await whatsapp(FIRST)).status).toBe(503);
    expect(markOf(FIRST)).toBeUndefined();
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ delivered: 1 });
    age(FIRST, 11 * MIN);
    expect((await whatsapp(FIRST)).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE, PARENT_PHONE]);
    expect(escalations()).toHaveLength(2);
  });
});

describe('a late WhatsApp redelivery after the sweep reached the manager but could not write its record', () => {
  /** Nobody reached at first; then the sweep reaches the parent and its record write is refused (and, if asked, the narrow "who was told" update too). */
  async function sweptButUnrecorded({ narrowUpdateRefused = false } = {}) {
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    seam.telephony.down = false;
    fail('guardian_escalations', 'upsert', 1);
    if (narrowUpdateRefused) fail('guardian_escalations', 'update', 1);
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, unavailable: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(callback(commKey())).toMatchObject({ status: 'error', error: 'Unable to record escalation.' });
  }

  it('texts and calls nobody again, however late: the claim the attempt marked is final', async () => {
    await sweptButUnrecorded();
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT] });
    // Twilio redelivers (or the signed request is replayed) once both claims
    // are past the ten minutes. The defect: the escalation's claim was
    // reclaimed like any other `error`, and the parent was texted and called
    // a second time.
    age(WA_SID, 11 * MIN);
    age(commKey(), 11 * MIN);
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(callback(commKey()), 'still final').toMatchObject({ status: 'error', error: 'Unable to record escalation.' });
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
    expect(escalations()).toHaveLength(1);
    expect((await tick()).body.escalations).toMatchObject({ examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('and when the narrow update failed as well, the final claim alone keeps the redelivery and the cron from sending again', async () => {
    await sweptButUnrecorded({ narrowUpdateRefused: true });
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [], sms_sent: false });
    age(WA_SID, 11 * MIN);
    age(commKey(), 11 * MIN);
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(callback(commKey())).toMatchObject({ status: 'error', error: 'Unable to record escalation.' });
    expect((await tick()).body.escalations).toMatchObject({ examined: 0, duplicate: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });
});

describe('an emergency whose texts and calls all failed AND whose record could not be written', () => {
  it('WhatsApp: leaves the work item, and the next tick lands the record and reaches the manager once', async () => {
    seam.telephony.down = true;
    fail('guardian_escalations', 'upsert');
    expect((await whatsapp()).status).toBe(503);
    expect(escalations()).toEqual([]);
    const comm = communications()[0].id;
    // The defect: parked with nothing anywhere for a sweep to find; the
    // manager text and call were never tried again.
    expect(owedItems()).toEqual([expect.objectContaining({ family_id: FAMILY, state: 'reserved', resource_table: 'guardian_escalations' })]);
    expect(callback(WA_SID), 'parked: a sweep owes it now').toMatchObject({ status: 'error' });
    const raisedAt = owedItems()[0].created_at;

    heal();
    seam.telephony.down = false;
    const { status, body } = await tick();
    expect(body.escalations).toMatchObject({ recovered: 1, examined: 1, delivered: 1, undelivered: 0, unavailable: 0 });
    expect(status).toBe(200);
    expect(escalations()).toEqual([expect.objectContaining({ communication_id: comm, notified_member_ids: [PARENT], sms_sent: true, call_attempted: true, escalated_at: raisedAt })]);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(owedItems()).toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect((await tick()).body.escalations).toMatchObject({ recovered: 0, examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('screening: the after() task leaves the work item, and the next tick reaches the manager once', async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue({
      responseText: 'Stay on the line.',
      decision: { action: 'voicemail', risk: 'safe', urgency: 'emergency', intent: 'personal', summary: 'Caller says grandpa collapsed.', callerName: 'Neighbour' },
    });
    const held: Array<() => Promise<void>> = [];
    seam.after.mockImplementation((task: () => Promise<void>) => { held.push(task); });
    seam.telephony.down = true;
    fail('guardian_escalations', 'upsert');
    const { POST } = await import('@/app/api/guardian/screen/route');
    expect((await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Grandpa collapsed, please hurry.' }, `?sessionId=${SESSION}&turn=1`))).status).toBe(200);
    await held[0]();
    // The defect: logged, and nothing anywhere to retry from.
    expect(escalations()).toEqual([]);
    expect(owedItems()).toHaveLength(1);

    heal();
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ recovered: 1, examined: 1, delivered: 1 });
    expect(escalations()).toEqual([expect.objectContaining({ communication_id: COMM, escalation_type: 'emergency_call', notified_member_ids: [PARENT] })]);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect((await tick()).body.escalations).toMatchObject({ examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('with the work item refused as well, WhatsApp gives the callback back rather than parking it where nothing looks', async () => {
    // The limit, pinned: with neither the record nor its work item written,
    // nothing durable names this escalation, so only a redelivery can retry it.
    seam.telephony.down = true;
    fail('guardian_escalations', 'upsert');
    fail('ai_tool_calls', 'insert');
    expect((await whatsapp()).status).toBe(503);
    expect(owedItems()).toEqual([]);
    expect(callback(WA_SID), 'released for the redelivery').toBeUndefined();
    heal();
    seam.telephony.down = false;
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(escalations()).toEqual([expect.objectContaining({ notified_member_ids: [PARENT] })]);
  });
});

describe('a sweep attempt that reached the manager but could not update the record', () => {
  async function undeliveredWhatsApp() {
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    seam.telephony.down = false;
  }

  it('records who was told, so a later tick does not text and call them again', async () => {
    await undeliveredWhatsApp();
    fail('guardian_escalations', 'upsert', 1);
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, unavailable: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(callback(commKey())).toMatchObject({ status: 'error', error: 'Unable to record escalation.' });
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    // The defect: the claim is reclaimable after ten minutes, the record said
    // nobody was reached, and the next tick texted and called again.
    age(commKey(), 11 * MIN);
    expect((await tick()).body.escalations).toMatchObject({ examined: 0 });
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
  });

  it('and when even that update fails, the claim\'s mark keeps the sweep from sending again', async () => {
    await undeliveredWhatsApp();
    fail('guardian_escalations', 'upsert', 1);
    fail('guardian_escalations', 'update', 1);
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, unavailable: 1 });
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [], sms_sent: false });
    age(commKey(), 11 * MIN);
    expect((await tick()).body.escalations).toMatchObject({ examined: 0, duplicate: 1 });
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
  });
});

describe('records that keep failing', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const OTHER_PARENT = '88888888-8888-4888-8888-888888888888';
  const REFUSED_PHONE = '+15550000111';
  const record = (familyId: string, description: string, agoMs: number) => {
    const input = { familyId, escalationType: 'urgent_personal' as const, severity: 'critical' as const, description, callerNumber: CALLER };
    return {
      id: guardianEscalationRecordId(input), family_id: familyId, communication_id: null, escalation_type: 'urgent_personal', severity: 'critical',
      description, caller_number: CALLER, notified_member_ids: [], push_sent: true, sms_sent: false, call_attempted: false, acknowledged_at: null,
      escalated_at: new Date(Date.now() - agoMs).toISOString(),
    };
  };

  it('do not hold every slot while a newer emergency waits: the retries go round in turn', async () => {
    // Ten older records for a family whose only number Twilio refuses every
    // time, and one newer emergency in another family whose first attempt
    // met a brief outage.
    db.seed('families', [{ id: OTHER, name: 'Other', timezone: 'UTC' }]);
    db.seed('family_members', [{ id: OTHER_PARENT, family_id: OTHER, user_id: 'u-other', display_name: 'Bo', is_active: true, role: 'parent' }]);
    db.replace('profiles', [{ id: 'u-parent', phone: PARENT_PHONE }, { id: 'u-other', phone: REFUSED_PHONE }]);
    seam.telephony.failFor.add(REFUSED_PHONE);
    db.seed('guardian_escalations', [
      ...Array.from({ length: 10 }, (_, i) => record(OTHER, `persistent emergency ${i}`, (10 * HOUR) - i * 30 * MIN)),
      record(FAMILY, 'a newer emergency whose first attempt met an outage', 5 * MIN),
    ]);
    const first = await tick();
    expect(first.body.escalations).toMatchObject({ examined: 10, undelivered: 10, delivered: 0 });
    // The defect: every tick took the same ten oldest, for as long as they
    // kept failing (up to a day), and the newer one was never attempted.
    const second = await tick();
    expect(second.body.escalations).toMatchObject({ delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(escalations().find((r) => r.family_id === FAMILY)).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true });
    // And the ones that keep failing are still taken in their turn.
    expect(second.body.escalations.undelivered).toBe(9);
  });
});

describe('a retry that lands hours after the emergency', () => {
  it('says it is delayed, when it was first raised in the family\'s zone, and how long ago, in the text and in the call', async () => {
    const raised = Date.parse('2026-10-11T00:11:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: raised + 20 * HOUR });
    const description = `Emergency WhatsApp from (555) 555-0199: "${EMERGENCY}"`;
    const input = { familyId: FAMILY, escalationType: 'urgent_personal' as const, severity: 'critical' as const, description, callerNumber: CALLER };
    db.seed('guardian_escalations', [{
      id: guardianEscalationRecordId(input), family_id: FAMILY, communication_id: null, escalation_type: 'urgent_personal', severity: 'critical',
      description, caller_number: CALLER, notified_member_ids: [], push_sent: true, sms_sent: false, call_attempted: false, acknowledged_at: null,
      escalated_at: new Date(raised).toISOString(),
    }]);
    expect((await tick()).body.escalations).toMatchObject({ delivered: 1 });
    // The defect: byte-for-byte the text of an emergency happening now.
    const delayed = 'DELAYED ALERT: first raised 2026-10-10 17:11 PDT (20 h ago). It may already be over.';
    expect(seam.texts).toHaveLength(1);
    // Leading the text, before the emergency it is about.
    expect(at(seam.texts[0], delayed)).toBeLessThan(at(seam.texts[0], EMERGENCY));
    expect(seam.calls).toHaveLength(1);
    const spoken = new URL(seam.calls[0]).searchParams.get('msg') ?? '';
    expect(spoken.startsWith(delayed)).toBe(true);
    expect(spoken).toContain(EMERGENCY);
  });

  it('an alert sent as the emergency happens carries no such line', async () => {
    expect((await whatsapp()).status).toBe(200);
    expect(seam.texts).toHaveLength(1);
    expect(seam.texts[0]).not.toContain('DELAYED');
    expect(new URL(seam.calls[0]).searchParams.get('msg')).not.toContain('DELAYED');
  });
});

describe('a late WhatsApp redelivery whose own reads fail', () => {
  const markOf = (smsSid: string) => db.table('ai_tool_calls').find((row) => row.tool_name === 'guardian.whatsapp_escalation_key' && row.idempotency_key === `guardian.whatsapp_escalation_key:v1:${smsSid}`);

  it('cannot read back the communication its sid names: given back for a retry, and nobody is texted, called or told twice', async () => {
    // The first delivery records the message and is keyed on it; nobody could
    // be reached at first, and the sweep then reaches the parent.
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    const comm = communications()[0].id;
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);

    // Redelivered after the ten minutes: the unique sid refuses the insert,
    // and the read of the row it names fails.
    age(WA_SID, 11 * MIN);
    fail('guardian_communications', 'select', 1);
    const late = await whatsapp();
    // The defect: with no communication it was keyed on its text, wrote a
    // mark saying so under its sid, took a new claim, and texted and called
    // the parent a second time.
    expect(late.status).toBe(503);
    expect(callback(WA_SID), 'given back for the retry').toBeUndefined();
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    expect(markOf(WA_SID)).toBeUndefined();
    expect(seam.notify).toHaveBeenCalledOnce();

    // The retry, with the read answering, joins the first escalation.
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(escalations()).toEqual([expect.objectContaining({ communication_id: comm, notified_member_ids: [PARENT] })]);
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
    // Each notice names the communication and is said once per communication.
    for (const [, input] of seam.notify.mock.calls) expect(input).toMatchObject({ relatedId: comm, once: true });
  });

  it('cannot read its sid\'s mark after the first delivery escalated under its text: not switched to its communication and alarmed again', async () => {
    // The first delivery's insert commits and its answer is lost, so it is
    // escalated under its text, written down under its sid. Nobody could be
    // reached at first; the sweep then reaches the parent.
    loseAnswer('guardian_communications');
    seam.telephony.down = true;
    expect((await whatsapp()).status).toBe(503);
    expect(markOf(WA_SID)).toBeDefined();
    seam.telephony.down = false;
    expect((await tick()).body.escalations).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);

    age(WA_SID, 11 * MIN);
    fail('ai_tool_calls', 'select', 1);
    const late = await whatsapp();
    // The defect: the failed read was taken for "no mark", and the delivery —
    // which did learn its communication — was keyed on it, took a new claim,
    // and texted and called the parent again.
    expect(late.status).toBe(503);
    expect(callback(WA_SID), 'given back for the retry').toBeUndefined();
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(escalations()).toEqual([expect.objectContaining({ id: guardianEscalationRecordId(byContent), communication_id: null })]);

    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
  });

  it('cannot read the mark after a first delivery that reached the parent itself and was never marked handled', async () => {
    // The first delivery's insert is refused outright, so it is escalated
    // under its text, and the parent is reached at once.
    fail('guardian_communications', 'insert', 1);
    expect((await whatsapp()).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    // Its callback was never marked handled (the update refused, or the
    // function ended after the alerts went out): reclaimable after ten minutes.
    callback(WA_SID)!.status = 'processing';
    age(WA_SID, 11 * MIN);

    // The redelivery records the message now, and cannot read the mark.
    fail('ai_tool_calls', 'select', 1);
    expect((await whatsapp()).status).toBe(503);
    expect(callback(WA_SID), 'given back for the retry').toBeUndefined();
    expect(seam.sent, 'texted once').toEqual([PARENT_PHONE]);
    expect(seam.called, 'called once').toEqual([PARENT_PHONE]);
    expect(communications()).toHaveLength(1);

    // The retry finds the message it recorded and joins the first escalation.
    expect((await whatsapp()).status).toBe(200);
    expect(communications()).toHaveLength(1);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(escalations()).toHaveLength(1);
    expect(seam.notify).toHaveBeenCalledOnce();
  });
});

describe('a screened emergency whose escalation could not run at all', () => {
  it.each([
    ['its claim could not be taken', () => fail('guardian_callback_events', 'insert', 1)],
    ['the managers could not be read', () => fail('family_members', 'select', 1)],
    ['their phone numbers could not be read', () => fail('profiles', 'select', 1)],
  ])('%s: the after() task leaves the work item, and the next tick reaches the manager once', async (_case, refuse) => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue({
      responseText: 'Stay on the line.',
      decision: { action: 'voicemail', risk: 'safe', urgency: 'emergency', intent: 'personal', summary: 'Caller says grandpa collapsed.', callerName: 'Neighbour' },
    });
    const held: Array<() => Promise<void>> = [];
    seam.after.mockImplementation((task: () => Promise<void>) => { held.push(task); });
    const { POST } = await import('@/app/api/guardian/screen/route');
    expect((await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Grandpa collapsed, please hurry.' }, `?sessionId=${SESSION}&turn=1`))).status).toBe(200);
    // The TwiML has gone out; the escalation then fails before sending anything.
    refuse();
    await held[0]();
    expect(seam.sent).toEqual([]);
    expect(escalations()).toEqual([]);
    // The defect: no record and no work item — the after() task only logged,
    // and no sweep could ever find it.
    expect(owedItems()).toEqual([expect.objectContaining({ family_id: FAMILY, state: 'reserved', resource_table: 'guardian_escalations' })]);

    heal();
    const { status, body } = await tick();
    expect(body.escalations).toMatchObject({ recovered: 1, examined: 1, delivered: 1, unavailable: 0 });
    expect(status).toBe(200);
    expect(escalations()).toEqual([expect.objectContaining({ communication_id: COMM, escalation_type: 'emergency_call', notified_member_ids: [PARENT], push_sent: true })]);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(owedItems()).toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect((await tick()).body.escalations).toMatchObject({ recovered: 0, examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });
});

describe('owed escalations that cannot be landed', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  type Owed = Row & { inputs: { version: 1; input: Row; pushSent: boolean } };
  /** The work item an escalation leaves when its record cannot be written, as oweGuardianEscalation writes it. */
  const owed = (familyId: string, description: string, agoMs: number): Owed => {
    const input = { familyId, escalationType: 'urgent_personal' as const, severity: 'critical' as const, description, callerNumber: CALLER };
    const eventId = guardianEscalationEventId(input);
    return {
      id: guardianEscalationStableId(eventId, 'owed'), family_id: familyId, tool_name: 'guardian.escalation_owed', actor_kind: 'system',
      inputs: { version: 1, input, pushSent: true }, outputs: null, state: 'reserved', attempt: 0,
      idempotency_key: `guardian.escalation_owed:v1:${eventId}`, resource_table: 'guardian_escalations', resource_id: guardianEscalationRecordId(input),
      created_at: new Date(Date.now() - agoMs).toISOString(),
    };
  };

  it.each([
    // A contact name long enough puts the description past what the sweep reads back.
    ['written in a shape the sweep cannot read', (item: Owed): Owed => ({ ...item, inputs: { ...item.inputs, input: { ...item.inputs.input, description: 'x'.repeat(5000) } } }), () => {}],
    ['whose record the database refuses every time', (item: Owed): Owed => item, () => refuseInsertsWhere('guardian_escalations', (row) => row.family_id === OTHER)],
  ])('ten %s do not hold every slot while a newer one waits', async (_case, shape, refuse) => {
    db.seed('families', [{ id: OTHER, name: 'Other', timezone: 'UTC' }]);
    refuse();
    db.seed('ai_tool_calls', [
      ...Array.from({ length: 10 }, (_, i) => shape(owed(OTHER, `persistent emergency ${i}`, (10 * HOUR) - i * 30 * MIN))),
      owed(FAMILY, 'a newer emergency whose record could not be written', 5 * MIN),
    ]);
    const first = await tick();
    expect(first.body.escalations).toMatchObject({ recovered: 0, unavailable: 10 });
    // The defect: every tick took the same ten oldest for as long as they
    // could not be landed (up to a day), and the newer one was never landed,
    // let alone retried. This is the work-item queue, not the record cursor.
    const second = await tick();
    expect(second.body.escalations).toMatchObject({ recovered: 1, examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(escalations()).toEqual([expect.objectContaining({ family_id: FAMILY, notified_member_ids: [PARENT], sms_sent: true })]);
    // And the ones that cannot be landed are still tried in their turn.
    expect(second.body.escalations.unavailable).toBe(9);
    expect(owedItems().filter((item) => item.state === 'reserved')).toHaveLength(10);
  });
});
