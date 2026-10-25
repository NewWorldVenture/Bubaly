// The inbound SMS and voicemail webhooks budget the concierge and the SMS
// auto-reply (audit RV1-N1-sibling-sms-voice).
//
// Driven through the real Twilio-signed routes against the in-memory database
// with the real durable limiter RPC (tests/helpers/rate-limit-rpc.ts). Before
// the fix every text and every voicemail Twilio delivered was one model call,
// and the SMS auto-reply was deduplicated per Twilio SID only: the only budgets
// on either lane were the urgent SMS lane's. The email lane got its budgets in
// audit N1 (tests/an-inbound-auto-reply-does-not-loop-or-reflect.test.ts);
// these are the sibling paths that fix did not cover.
//
// The controls keep this from passing by withholding everything: a text from a
// neighbour is still classified by the concierge and still answered, once, by
// TwiML, and a voicemail is still classified.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import {
  SMS_CONCIERGE_PER_FAMILY_PER_DAY, SMS_CONCIERGE_PER_SENDER_PER_DAY, SMS_REPLY_PER_FAMILY_PER_DAY, SMS_REPLY_PER_SENDER_PER_DAY,
  VOICE_CONCIERGE_PER_FAMILY_PER_DAY, VOICE_CONCIERGE_PER_SENDER_PER_DAY,
} from '@/lib/contact-center/inbound-budget';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), admin: vi.fn(), concierge: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: vi.fn(() => { throw new Error('Unexpected planner call'); }) }));
vi.mock('@/lib/guardian/twilio', async original => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => false,
  sendSmsWithReceipt: vi.fn(() => { throw new Error('Unexpected provider call'); }),
}));

const ORIGIN = 'https://bubaly.example';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const FAMILY_NUMBER = '+15555550100';
const NEIGHBOUR = '+15555550200';
const TOKEN = 'synthetic-contact-center-token';
const SMS = '/api/contact-center/sms';
const VOICEMAIL = `/api/contact-center/voice/transcription?familyId=${FAMILY}`;
const EMITS = /<Message(?:\s|>)/;
let db: ReturnType<typeof createInMemorySupabase>;
let sequence = 0;

function signed(path: string, params: Record<string, string>) {
  const url = `${ORIGIN}${path}`;
  const payload = url + Object.keys(params).sort().map(key => key + params[key]).join('');
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': createHmac('sha1', TOKEN).update(payload).digest('base64') },
    body: new URLSearchParams(params),
  });
}
/** One Twilio-delivered text, a fresh MessageSid each time unless one is given. */
async function text(fields: Record<string, string> = {}) {
  sequence += 1;
  const { POST } = await import('@/app/api/contact-center/sms/route');
  const response = await POST(signed(SMS, {
    To: FAMILY_NUMBER, From: NEIGHBOUR, Body: 'Just letting you know', MessageSid: `SM${String(sequence).padStart(32, '0')}`, ...fields,
  }));
  return { status: response.status, emits: EMITS.test(await response.text()) };
}
/** One Twilio transcription callback, a fresh RecordingSid each time. */
async function voicemail(fields: Record<string, string> = {}) {
  sequence += 1;
  const { POST } = await import('@/app/api/contact-center/voice/transcription/route');
  return (await POST(signed(VOICEMAIL, {
    To: FAMILY_NUMBER, From: NEIGHBOUR, TranscriptionText: 'Just letting you know', RecordingSid: `RE${String(sequence).padStart(32, '0')}`, ...fields,
  }))).status;
}
const sender = (n: number) => `+1555555${String(n).padStart(4, '0')}`;
const inbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'inbound');
const outbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'outbound');
const replyReceipts = () => db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.sms_reply');
const urgentReceipts = () => db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.urgent_delivery');

function freshDb(withLimiter = true) {
  const next = createInMemorySupabase({
    uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new', occurred_at: '2026-09-12T00:00:00.000Z' } },
    ...(withLimiter ? { rpc: { rate_limit_hit: rateLimitHit } } : {}),
  });
  next.seed('families', [{ id: FAMILY, name: 'Ours', timezone: 'UTC' }]);
  next.seed('family_contact_channels', [{ id: 'channel-ours', family_id: FAMILY, phone_number: FAMILY_NUMBER, email_local: 'ours', ai_concierge_enabled: true, forward_to_phone: null }]);
  mocks.admin.mockReturnValue(next);
  return next;
}

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  sequence = 0;
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('TWILIO_ACCOUNT_SID', '');
  // The per-sender budget keys hold a phone number, which the durable limiter
  // digests under a server secret and refuses to store without one in
  // production (the-rate-limit-table-is-not-a-visitor-log).
  vi.stubEnv('INTERNAL_SECRET', 'synthetic-internal-secret');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  db = freshDb();
  // 'other' from the model where the deterministic classifier says 'personal':
  // a row that reads 'other' was classified by the concierge, one that reads
  // 'personal' was filed with the fallback verdict.
  mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'A simple note', reply: 'Thanks, received.', aiUsed: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('control: a text is classified by the concierge and answered once by TwiML', () => {
  it('runs the concierge, emits one <Message> and records one outbound row', async () => {
    expect(await text()).toEqual({ status: 200, emits: true });
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0]).toMatchObject({ ai_intent: 'other', ai_summary: 'A simple note', from_addr: NEIGHBOUR });
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0]).toMatchObject({ to_addr: NEIGHBOUR, body: 'Thanks, received.' });
  });

  it('stores the budget under a digest of the number, never the number', async () => {
    expect((await text()).status).toBe(200);
    const keys = db.table('rate_limits').map(row => String(row.bucket_key));
    expect(keys.some(key => key.startsWith(`cc-sms:sender:${FAMILY}:h.`))).toBe(true);
    expect(keys.some(key => key.startsWith(`cc-sms-reply:${FAMILY}:h.`))).toBe(true);
    for (const key of keys) expect(key).not.toContain(NEIGHBOUR.slice(1));
  });
});

describe('SMS: the concierge is budgeted before the model is asked', () => {
  it(`one sender draws at most ${SMS_CONCIERGE_PER_SENDER_PER_DAY} concierge runs a day; the rest are filed with the deterministic classification and no reply is prepared`, async () => {
    for (let i = 0; i < SMS_CONCIERGE_PER_SENDER_PER_DAY + 2; i += 1) expect((await text()).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledTimes(SMS_CONCIERGE_PER_SENDER_PER_DAY);
    expect(inbound()).toHaveLength(SMS_CONCIERGE_PER_SENDER_PER_DAY + 2);
    const withheld = inbound().slice(SMS_CONCIERGE_PER_SENDER_PER_DAY);
    expect(withheld.map(row => row.ai_intent)).toEqual(['personal', 'personal']);
    expect(withheld.map(row => row.ai_summary)).toEqual(['Just letting you know', 'Just letting you know']);
    // No reply occasion is even prepared for a withheld text.
    expect(replyReceipts()).toHaveLength(SMS_CONCIERGE_PER_SENDER_PER_DAY);
  });

  it(`one family number draws at most ${SMS_CONCIERGE_PER_FAMILY_PER_DAY} concierge runs a day across every sender`, async () => {
    for (let i = 0; i < SMS_CONCIERGE_PER_FAMILY_PER_DAY + 2; i += 1) expect((await text({ From: sender(i) })).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledTimes(SMS_CONCIERGE_PER_FAMILY_PER_DAY);
    expect(inbound()).toHaveLength(SMS_CONCIERGE_PER_FAMILY_PER_DAY + 2);
    expect(inbound().slice(SMS_CONCIERGE_PER_FAMILY_PER_DAY).map(row => row.ai_intent)).toEqual(['personal', 'personal']);
  });

  it('a From that is not a number is still bounded by the family budget', async () => {
    expect((await text({ From: 'SCHOOL' })).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledOnce();
    const keys = db.table('rate_limits').map(row => String(row.bucket_key));
    expect(keys).toContain(`cc-sms:family:${FAMILY}`);
    expect(keys.some(key => key.startsWith('cc-sms:sender:'))).toBe(false);
  });

  it('a limiter that cannot be read withholds the concierge and the reply and still files the text', async () => {
    db = freshDb(false);
    expect(await text()).toEqual({ status: 200, emits: false });
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0]).toMatchObject({ ai_intent: 'personal' });
    expect(outbound()).toEqual([]);
  });

  it('a replay over budget keeps the frozen candidate instead of classifying the text again', async () => {
    // The deterministic classifier calls this urgent; the concierge did not.
    // Re-classifying a replay would mint an urgent escalation for a text the
    // concierge had already filed as ordinary.
    mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'A question about the gate', reply: 'Noted.', aiUsed: true });
    const first = `SM${'f'.repeat(32)}`;
    expect(await text({ Body: 'Help me find the gate', MessageSid: first })).toEqual({ status: 200, emits: true });
    for (let i = 1; i < SMS_CONCIERGE_PER_SENDER_PER_DAY; i += 1) expect((await text()).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledTimes(SMS_CONCIERGE_PER_SENDER_PER_DAY);
    const replay = await text({ Body: 'Help me find the gate', MessageSid: first });
    expect(replay).toEqual({ status: 200, emits: false });
    expect(mocks.concierge).toHaveBeenCalledTimes(SMS_CONCIERGE_PER_SENDER_PER_DAY);
    expect(inbound()).toHaveLength(SMS_CONCIERGE_PER_SENDER_PER_DAY);
    expect(inbound()[0]).toMatchObject({ ai_intent: 'other', ai_summary: 'A question about the gate' });
    expect(urgentReceipts()).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
  });
});

describe('SMS: the auto-reply is budgeted per sender and per family before it is emitted', () => {
  it(`one sender draws at most ${SMS_REPLY_PER_SENDER_PER_DAY} replies a day; later texts are still classified and filed, without a reply`, async () => {
    const answers: boolean[] = [];
    for (let i = 0; i < SMS_REPLY_PER_SENDER_PER_DAY + 2; i += 1) {
      const delivered = await text();
      expect(delivered.status).toBe(200);
      answers.push(delivered.emits);
    }
    expect(answers).toEqual([...Array(SMS_REPLY_PER_SENDER_PER_DAY).fill(true), false, false]);
    expect(mocks.concierge).toHaveBeenCalledTimes(SMS_REPLY_PER_SENDER_PER_DAY + 2);
    expect(inbound()).toHaveLength(SMS_REPLY_PER_SENDER_PER_DAY + 2);
    expect(inbound().at(-1)).toMatchObject({ ai_intent: 'other' });
    expect(outbound()).toHaveLength(SMS_REPLY_PER_SENDER_PER_DAY);
  });

  it(`one family number sends at most ${SMS_REPLY_PER_FAMILY_PER_DAY} replies a day across every sender`, async () => {
    let answered = 0;
    for (let i = 0; i < SMS_REPLY_PER_FAMILY_PER_DAY + 2; i += 1) {
      const delivered = await text({ From: sender(i) });
      expect(delivered.status).toBe(200);
      if (delivered.emits) answered += 1;
    }
    expect(answered).toBe(SMS_REPLY_PER_FAMILY_PER_DAY);
    expect(outbound()).toHaveLength(SMS_REPLY_PER_FAMILY_PER_DAY);
    expect(inbound()).toHaveLength(SMS_REPLY_PER_FAMILY_PER_DAY + 2);
  });

  it('a replay of an answered text is not charged again', async () => {
    const same = `SM${'e'.repeat(32)}`;
    expect(await text({ MessageSid: same })).toEqual({ status: 200, emits: true });
    for (let i = 0; i < 3; i += 1) expect(await text({ MessageSid: same })).toEqual({ status: 200, emits: false });
    // The replays spent nothing: the sender still has the rest of the day's replies.
    for (let i = 1; i < SMS_REPLY_PER_SENDER_PER_DAY; i += 1) expect(await text()).toEqual({ status: 200, emits: true });
    expect(outbound()).toHaveLength(SMS_REPLY_PER_SENDER_PER_DAY);
  });
});

describe('voicemail: the concierge is budgeted per caller and per family', () => {
  it(`one caller draws at most ${VOICE_CONCIERGE_PER_SENDER_PER_DAY} concierge runs a day; the rest are filed with the deterministic classification`, async () => {
    for (let i = 0; i < VOICE_CONCIERGE_PER_SENDER_PER_DAY + 2; i += 1) expect(await voicemail()).toBe(204);
    expect(mocks.concierge).toHaveBeenCalledTimes(VOICE_CONCIERGE_PER_SENDER_PER_DAY);
    expect(inbound()).toHaveLength(VOICE_CONCIERGE_PER_SENDER_PER_DAY + 2);
    const withheld = inbound().slice(VOICE_CONCIERGE_PER_SENDER_PER_DAY);
    expect(withheld.map(row => [row.channel, row.ai_intent, row.ai_summary])).toEqual([
      ['voice', 'personal', 'Just letting you know'], ['voice', 'personal', 'Just letting you know'],
    ]);
    const keys = db.table('rate_limits').map(row => String(row.bucket_key));
    expect(keys.some(key => key.startsWith(`cc-voice:sender:${FAMILY}:h.`))).toBe(true);
    for (const key of keys) expect(key).not.toContain(NEIGHBOUR.slice(1));
  });

  it(`one family number draws at most ${VOICE_CONCIERGE_PER_FAMILY_PER_DAY} concierge runs a day across every caller`, async () => {
    for (let i = 0; i < VOICE_CONCIERGE_PER_FAMILY_PER_DAY + 2; i += 1) expect(await voicemail({ From: sender(i) })).toBe(204);
    expect(mocks.concierge).toHaveBeenCalledTimes(VOICE_CONCIERGE_PER_FAMILY_PER_DAY);
    expect(inbound()).toHaveLength(VOICE_CONCIERGE_PER_FAMILY_PER_DAY + 2);
  });

  it('a limiter that cannot be read withholds the concierge and still files the voicemail', async () => {
    db = freshDb(false);
    expect(await voicemail()).toBe(204);
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0]).toMatchObject({ channel: 'voice', ai_intent: 'personal', subject: 'Voicemail' });
  });

  it('under budget a voicemail is classified by the concierge (control)', async () => {
    expect(await voicemail()).toBe(204);
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(inbound()[0]).toMatchObject({ channel: 'voice', ai_intent: 'other', ai_summary: 'A simple note' });
  });
});
