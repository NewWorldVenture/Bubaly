// The inbound-email webhook budgets its work and its replies, and neither loops
// nor reflects (audit N1, N2, N6).
//
// Driven through the real webhook against the in-memory database. Before the
// fix every case below did the thing it now refuses: the concierge ran and the
// attachments were extracted for every message with a fresh Message-Id; the
// reply went to the raw From header, carried no mark that it was automatic,
// echoed the sender's subject verbatim and had no budget. So a forged From on a
// stranger's mail had the family's verified @bubaly.com address write to that
// stranger, under a 1,000-character subject of the sender's choosing, as many
// times as the sender cared to mail — and a remote auto-responder (or a forged
// From on bubaly.com) turned one message into an unbounded cycle of model
// calls, inbox rows and outbound mail.
//
// The controls are what keep this from passing by withholding everything: a
// plain message from a teacher is still classified by the concierge, still
// answered, once, at the one mailbox in its From, marked Auto-Submitted, under
// a bounded subject.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import {
  AUTO_REPLY_HEADERS, EMAIL_CONCIERGE_PER_FAMILY_PER_DAY, EMAIL_CONCIERGE_PER_SENDER_PER_DAY,
  EMAIL_REPLY_PER_FAMILY_PER_DAY, EMAIL_REPLY_PER_SENDER_PER_DAY, MAX_REPLY_SUBJECT,
} from '@/lib/contact-center/inbound-mail';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), sendEmail: vi.fn(), concierge: vi.fn(), attachments: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/server/email', async original => ({
  ...await original<typeof import('@/lib/server/email')>(), sendEmail: mocks.sendEmail,
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/services/paperwork/email-attachments', async original => ({
  ...await original<typeof import('@/lib/services/paperwork/email-attachments')>(), fileEmailAttachments: mocks.attachments,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: vi.fn(() => { throw new Error('Unexpected planner call'); }) }));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: () => false,
  sendSmsWithReceipt: vi.fn(() => { throw new Error('Unexpected provider call'); }),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const URL = 'https://bubaly.example/api/contact-center/email';
const SECRET = 'synthetic-inbound-secret';
let db: ReturnType<typeof createInMemorySupabase>;
let sequence = 0;

/** One inbound delivery to ours@bubaly.com; every field can be overridden or added. */
function request(fields: Record<string, unknown> = {}) {
  sequence += 1;
  return new NextRequest(URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': SECRET },
    body: JSON.stringify({
      to: 'Ours <ours@bubaly.com>', from: 'Teacher <teacher@school.example>', subject: 'Hello',
      text: 'A simple note.', messageId: `<message-${sequence}@school.example>`, ...fields,
    }),
  });
}
/** The same delivery as multipart/form-data, with one attachment. */
function multipart(fields: Record<string, string> = {}) {
  sequence += 1;
  const form = new FormData();
  for (const [key, value] of Object.entries({
    to: 'Ours <ours@bubaly.com>', from: 'Teacher <teacher@school.example>', subject: 'Hello',
    text: 'A simple note.', 'Message-Id': `<message-${sequence}@school.example>`, ...fields,
  })) form.set(key, value);
  form.set('attachment', new File(['%PDF-1.7\nPermission slip'], 'slip.pdf', { type: 'application/pdf' }));
  return new NextRequest(URL, { method: 'POST', headers: { 'x-inbound-secret': SECRET }, body: form });
}
const route = async () => (await import('@/app/api/contact-center/email/route')).POST;
const deliver = async (fields?: Record<string, unknown>) => (await route())(request(fields));
const inbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'inbound');
const outbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'outbound');

function freshDb(withLimiter = true) {
  const next = createInMemorySupabase({
    uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' } },
    ...(withLimiter ? { rpc: { rate_limit_hit: rateLimitHit } } : {}),
  });
  next.seed('families', [{ id: FAMILY, name: 'Ours', timezone: 'UTC' }]);
  next.seed('subscriptions', [{ family_id: FAMILY, plan: 'plus', status: 'active' }]);
  next.seed('family_contact_channels', [{ id: 'channel-ours', family_id: FAMILY, email_local: 'ours', ai_concierge_enabled: true, forward_to_phone: null }]);
  mocks.admin.mockReturnValue(next);
  return next;
}

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  sequence = 0;
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', SECRET);
  // The per-sender budget keys hold an address, which the durable limiter
  // digests under a server secret and refuses to store without one in
  // production (the-rate-limit-table-is-not-a-visitor-log).
  vi.stubEnv('INTERNAL_SECRET', 'synthetic-internal-secret');
  vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  db = freshDb();
  mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'A simple note', reply: 'Thanks, received.', aiUsed: true });
  mocks.attachments.mockResolvedValue({ ok: true, results: [] });
  mocks.sendEmail.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Filed (the inbox row is there) but not answered (no mail, no outbound row). */
async function filedWithoutReply(fields: Record<string, unknown>) {
  expect((await deliver(fields)).status).toBe(200);
  expect(inbound()).toHaveLength(1);
  expect(mocks.sendEmail).not.toHaveBeenCalled();
  expect(outbound()).toEqual([]);
}

describe('control: a plain message is classified, answered once, at its one mailbox, marked automatic', () => {
  it('runs the concierge and replies with Auto-Submitted to the parsed address under the bounded subject', async () => {
    expect((await deliver()).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'teacher@school.example', subject: 'Re: Hello', headers: AUTO_REPLY_HEADERS });
    expect(AUTO_REPLY_HEADERS).toEqual({ 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', Precedence: 'auto_reply' });
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0]).toMatchObject({ to_addr: 'teacher@school.example' });
  });

  it('sendEmail puts the headers on the wire, and nothing else changes without them', async () => {
    vi.stubEnv('RESEND_API_KEY', 'synthetic-email-test-key');
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }));
    const { sendEmail } = await vi.importActual<typeof import('@/lib/server/email')>('@/lib/server/email');
    await sendEmail({ to: 'teacher@school.example', subject: 'Re: Hello', html: '<p>x</p>', headers: AUTO_REPLY_HEADERS });
    await sendEmail({ to: 'teacher@school.example', subject: 'Re: Hello', html: '<p>x</p>' });
    expect(bodies[0].headers).toEqual(AUTO_REPLY_HEADERS);
    expect(bodies[1]).not.toHaveProperty('headers');
  });
});

describe('N1: the concierge and the extraction are budgeted before the model is asked', () => {
  it(`one sender draws at most ${EMAIL_CONCIERGE_PER_SENDER_PER_DAY} concierge runs a day; the rest are filed with the deterministic classification`, async () => {
    for (let i = 0; i < EMAIL_CONCIERGE_PER_SENDER_PER_DAY + 2; i += 1) expect((await deliver()).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledTimes(EMAIL_CONCIERGE_PER_SENDER_PER_DAY);
    expect(inbound()).toHaveLength(EMAIL_CONCIERGE_PER_SENDER_PER_DAY + 2);
    // The withheld ones are still filed, with routing.ts's own verdict for the text.
    const withheld = inbound().slice(EMAIL_CONCIERGE_PER_SENDER_PER_DAY);
    expect(withheld.map(row => row.ai_intent)).toEqual(['personal', 'personal']);
    expect(withheld.map(row => row.ai_summary)).toEqual(['A simple note.', 'A simple note.']);
  });

  it('over budget, attachments are not extracted and the delivery says so', async () => {
    const post = await route();
    expect((await post(multipart())).status).toBe(200);
    // Control: under budget, the extraction runs and is handed the file.
    expect(mocks.attachments).toHaveBeenCalledOnce();
    expect((mocks.attachments.mock.calls[0][1] as { files: File[] }).files.map((file) => file.name)).toEqual(['slip.pdf']);
    for (let i = 1; i < EMAIL_CONCIERGE_PER_SENDER_PER_DAY; i += 1) expect((await deliver()).status).toBe(200);
    const extractions = mocks.attachments.mock.calls.length;
    const refused = await post(multipart());
    expect(refused.status).toBe(200);
    // Not even called: no OCR, no provider resolution, no paperwork write.
    expect(mocks.attachments.mock.calls.length).toBe(extractions);
    expect(await refused.json()).toMatchObject({ ok: true, attachments: [{ filename: 'slip.pdf', status: 'skipped', reason: 'concierge_budget' }] });
    expect(inbound()).toHaveLength(EMAIL_CONCIERGE_PER_SENDER_PER_DAY + 1);
  });

  it('over budget, no auto-reply goes out either', async () => {
    for (let i = 0; i < EMAIL_CONCIERGE_PER_SENDER_PER_DAY; i += 1) await deliver();
    mocks.sendEmail.mockClear();
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it(`one family address draws at most ${EMAIL_CONCIERGE_PER_FAMILY_PER_DAY} concierge runs a day across every sender`, async () => {
    for (let i = 0; i < EMAIL_CONCIERGE_PER_FAMILY_PER_DAY + 2; i += 1) {
      expect((await deliver({ from: `Sender ${i} <sender-${i}@school.example>` })).status).toBe(200);
    }
    expect(mocks.concierge).toHaveBeenCalledTimes(EMAIL_CONCIERGE_PER_FAMILY_PER_DAY);
    expect(inbound()).toHaveLength(EMAIL_CONCIERGE_PER_FAMILY_PER_DAY + 2);
  });

  it('a From that is not one mailbox is still bounded by the family budget, and never answered', async () => {
    expect((await deliver({ from: 'a@x.example, b@y.example' })).status).toBe(200);
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('a limiter that cannot be read withholds the concierge and the reply and still files the message', async () => {
    db = freshDb(false);
    await filedWithoutReply({});
    expect(mocks.concierge).not.toHaveBeenCalled();
  });
});

describe('N2: the reply does not reflect a stranger\'s text at an address the stranger named', () => {
  it('a forged From whose authentication the provider says failed is never answered, whatever the subject', async () => {
    const phishing = 'Your account is suspended, verify at bubaly-secure.example now '.repeat(20).slice(0, 1000);
    await filedWithoutReply({ from: 'Victim <victim@example.com>', subject: phishing, SPF: 'fail' });
  });

  it(`truncates a 1,000-character subject to ${MAX_REPLY_SUBJECT} and strips control characters and line separators`, async () => {
    const phishing = 'Your account is suspended '.repeat(50).slice(0, 1000);
    expect((await deliver({ subject: phishing })).status).toBe(200);
    const subject = mocks.sendEmail.mock.calls[0][0].subject as string;
    expect(subject.startsWith('Re: ')).toBe(true);
    expect(subject.length).toBeLessThanOrEqual('Re: '.length + MAX_REPLY_SUBJECT);
    expect((await deliver({ subject: 'Hello\r\nBcc: victim@example.com\u2028X-Injected: yes\u0007' })).status).toBe(200);
    expect(mocks.sendEmail.mock.calls[1][0].subject).toBe('Re: Hello Bcc: victim@example.com X-Injected: yes');
  });

  it('falls back to the fixed wording when nothing printable remains', async () => {
    expect((await deliver({ subject: '\u0001\u0002\r\n\u2029' })).status).toBe(200);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe('Message received — Ours');
  });

  it.each([
    ['SendGrid SPF: fail', { SPF: 'fail' }],
    ['SendGrid dkim fail with no SPF', { dkim: '{@school.example : fail}' }],
    ['Mailgun X-Mailgun-Spf: Fail', { 'X-Mailgun-Spf': 'Fail', 'X-Mailgun-Dkim-Check-Result': 'Fail' }],
    ['Authentication-Results spf=fail dkim=none', { headers: 'Authentication-Results: mx.bubaly.com; spf=fail smtp.mailfrom=school.example; dkim=none\n' }],
    ['dmarc=fail outranks an spf pass', { headers: 'Authentication-Results: mx.bubaly.com; spf=pass; dkim=fail; dmarc=fail\n' }],
  ])('a sender the provider says failed authentication is not answered: %s', async (_label, fields) => {
    await filedWithoutReply(fields);
  });

  it.each([
    ['no result stated at all', {}],
    ['SPF pass', { SPF: 'pass' }],
    ['DKIM pass beside an SPF softfail (a forwarder)', { SPF: 'softfail', dkim: '{@school.example : pass}' }],
    ['dmarc=pass', { headers: 'Authentication-Results: mx.bubaly.com; spf=fail; dkim=pass; dmarc=pass\n' }],
  ])('%s is answered (control)', async (_label, fields) => {
    expect((await deliver(fields)).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });
});

describe('N6: the reply goes to exactly one mailbox parsed from From, or to nobody', () => {
  it.each([
    ['empty From', { from: '' }],
    ['an empty envelope sender', { from: '<>' }],
    ['a comma list', { from: 'a@x.example, b@y.example' }],
    ['two bracketed mailboxes', { from: 'A <a@x.example>, B <b@y.example>' }],
    ['text after the bracket', { from: 'A <a@x.example> b@y.example' }],
    ['group syntax', { from: 'Parents: a@x.example;' }],
    ['a display name alone', { from: 'Just A Name' }],
    ['a control character', { from: 'A <a@x.example>\r\nBcc: b@y.example' }],
    ['no domain dot', { from: 'a@localhost' }],
    ['an address past 254 octets', { from: `${'a'.repeat(250)}@x.example` }],
  ])('%s is filed without a reply', async (_label, fields) => {
    await filedWithoutReply(fields);
  });

  it('a bare address and a named address are each one mailbox (control)', async () => {
    expect((await deliver({ from: 'teacher@school.example' })).status).toBe(200);
    expect((await deliver({ from: '"Teacher, Head" <head@school.example>' })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail.mock.calls.map(call => call[0].to)).toEqual(['teacher@school.example', 'head@school.example']);
  });

  it.each([
    ['MAILER-DAEMON', { from: 'MAILER-DAEMON@mx.school.example' }],
    ['postmaster', { from: 'Postmaster <postmaster@school.example>' }],
    ['no-reply', { from: 'no-reply@school.example' }],
    ['bounces+token', { from: 'bounces+abc@school.example' }],
    ['a kid login address', { from: 'child.emma@kids.bubaly.app' }],
  ])('a %s mailbox is never answered', async (_label, fields) => {
    await filedWithoutReply(fields);
  });
});

describe('N6: mail that announces itself as automatic is filed but never answered', () => {
  it.each([
    ['Auto-Submitted: auto-replied as a top-level field', { 'Auto-Submitted': 'auto-replied' }],
    ['Auto-Submitted: auto-generated in a raw headers blob (SendGrid)', { headers: 'Received: from mx\r\nAuto-Submitted: auto-generated\r\nSubject: Hello\r\n' }],
    ['Auto-Submitted in a structured Headers list (Postmark)', { Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied (vacation)' }] }],
    ['Auto-Submitted in message-headers JSON (Mailgun)', { 'message-headers': JSON.stringify([['Auto-Submitted', 'auto-replied']]) }],
    ['Precedence: bulk', { Precedence: 'bulk' }],
    ['Precedence: auto_reply', { headers: 'Precedence: auto_reply\n' }],
    ['X-Auto-Response-Suppress (Exchange)', { 'X-Auto-Response-Suppress': 'All' }],
    ['X-Autoreply', { 'X-Autoreply': 'yes' }],
    ['a List-Id', { 'List-Id': 'Parents <parents.school.example>' }],
    ['a List-Unsubscribe link', { headers: 'List-Unsubscribe: <mailto:leave@list.example>\n' }],
  ])('%s', async (_label, fields) => {
    await filedWithoutReply(fields);
  });

  it('Auto-Submitted: no is not an auto-responder (control)', async () => {
    expect((await deliver({ 'Auto-Submitted': 'no' })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });
});

describe('N6: our own addresses are never answered, so a forged From cannot close a loop', () => {
  it.each([
    ['From on bubaly.com (a second family address)', { from: 'Theirs <theirs@bubaly.com>' }],
    ['From equal to the product sender', { from: 'Bubaly <notifications@bubaly.com>' }],
    ['Reply-To on bubaly.com behind an outside From', { 'Reply-To': 'theirs@bubaly.com' }],
    ['reply-to as a lowercase top-level field', { 'reply-to': 'Them <theirs@bubaly.com>' }],
  ])('%s', async (_label, fields) => {
    await filedWithoutReply(fields);
  });

  it('the product sender is refused on any domain, not only bubaly.com', async () => {
    vi.stubEnv('EMAIL_FROM', 'Bubaly <onboarding@resend.dev>');
    await filedWithoutReply({ from: 'onboarding@resend.dev' });
  });
});

describe('N2, N6: replies are budgeted per sender inbox and per family address', () => {
  it(`one sender draws at most ${EMAIL_REPLY_PER_SENDER_PER_DAY} replies a day; the rest are filed without one`, async () => {
    for (let i = 0; i < EMAIL_REPLY_PER_SENDER_PER_DAY + 2; i += 1) expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAIL_REPLY_PER_SENDER_PER_DAY);
    expect(inbound()).toHaveLength(EMAIL_REPLY_PER_SENDER_PER_DAY + 2);
    expect(outbound()).toHaveLength(EMAIL_REPLY_PER_SENDER_PER_DAY);
  });

  it('sub-addresses of one inbox share the budget', async () => {
    for (const tag of ['a', 'b', 'c', 'd', 'e']) expect((await deliver({ from: `Loop <loop+${tag}@gmail.com>` })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAIL_REPLY_PER_SENDER_PER_DAY);
  });

  it('a redelivered message is charged once, so retries do not spend the budget', async () => {
    for (let i = 0; i < 3; i += 1) expect((await deliver({ messageId: '<same@school.example>' })).status).toBe(200);
    expect((await deliver({ messageId: '<second@school.example>' })).status).toBe(200);
    expect((await deliver({ messageId: '<third@school.example>' })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
  });

  it(`one family address sends at most ${EMAIL_REPLY_PER_FAMILY_PER_DAY} replies a day across every sender`, async () => {
    for (let i = 0; i < EMAIL_REPLY_PER_FAMILY_PER_DAY + 3; i += 1) {
      expect((await deliver({ from: `Sender ${i} <sender-${i}@school.example>` })).status).toBe(200);
    }
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAIL_REPLY_PER_FAMILY_PER_DAY);
    expect(inbound()).toHaveLength(EMAIL_REPLY_PER_FAMILY_PER_DAY + 3);
  });

  it('a withheld reply closes its reservation, so a redelivery does not send it later', async () => {
    for (let i = 0; i < EMAIL_REPLY_PER_SENDER_PER_DAY; i += 1) await deliver();
    expect((await deliver({ messageId: '<late@school.example>' })).status).toBe(200);
    expect((await deliver({ messageId: '<late@school.example>' })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(EMAIL_REPLY_PER_SENDER_PER_DAY);
    const receipts = db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.email_reply');
    expect(receipts).toHaveLength(EMAIL_REPLY_PER_SENDER_PER_DAY + 1);
    expect(receipts.at(-1)).toMatchObject({ state: 'failed', outputs: { phase: 'not_sent' } });
  });
});
