// #771 comment 5983397717. The Contact Center acknowledged EVERY non-spam
// email a family address received, including mail that was itself automatic:
// an out-of-office, a bounce, a mailing list, another family's acknowledgement.
// Each of those answers back, so the two sides traded mail (and our side a
// concierge call) for as long as both stayed up. A provider redelivery of a
// message already filed was acknowledged again. The reply also carried no
// Auto-Submitted header, so the other side's responder could not tell.
// Real route, intake and timeline; synthetic storage and delivery.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), sendEmail: vi.fn(), concierge: vi.fn(), translate: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/server/email', async original => ({
  ...await original<typeof import('@/lib/server/email')>(), sendEmail: mocks.sendEmail,
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => mocks.translate }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: vi.fn(() => { throw new Error('Unexpected planner call'); }) }));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: () => false,
  sendSmsWithReceipt: vi.fn(() => { throw new Error('Unexpected provider call'); }),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const SENDER = 'Teacher <teacher@school.example>';
const REPLY = 'Thank you & see <notes>.';
const LOCALIZED = 'Guardado & pendiente <revisar>.';
let db: ReturnType<typeof createInMemorySupabase>;

function request(extra: Record<string, string> = {}) {
  return new NextRequest('https://bubaly.example/api/contact-center/email', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': 'synthetic-inbound-secret' },
    body: JSON.stringify({
      to: 'Ours <ours@bubaly.com>', from: SENDER, subject: 'Hello', text: 'A simple note.', messageId: 'reply-fixture', ...extra,
    }),
  });
}
const deliver = async (extra: Record<string, string> = {}) => (await import('@/app/api/contact-center/email/route')).POST(request(extra));
const outbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'outbound');
const inbound = () => db.table('family_inbox_messages').filter(row => row.direction === 'inbound');

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'synthetic-inbound-secret');
  vi.stubEnv('EMAIL_FROM', 'Bubaly <notifications@bubaly.com>');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = createInMemorySupabase({
    uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Ours', timezone: 'UTC' }]);
  // The route gates inbound email on FAMILY_EMAIL_MIN_PLAN_LEVEL (Family+), and
  // resolveFamilyPlanLevel reads subscriptions through the service-role client.
  // Without a qualifying row this family is Free, the route answers
  // { ok: true, skipped: 'plan' } before any reply is composed, and every case
  // below silently tests the gate instead of the reply behaviour it was written
  // for. tests/family-email-plan-gate.test.ts is what covers the gate itself.
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'plus', status: 'active' }]);
  db.seed('family_contact_channels', [{
    id: 'channel-ours', family_id: FAMILY, email_local: 'ours', ai_concierge_enabled: true, forward_to_phone: null,
  }]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'A simple note', reply: REPLY, aiUsed: false });
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.translate.mockImplementation((key: string) => key === 'contactUrgent.replySaved' ? LOCALIZED : key);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

import { autoReplyRefusal, inboundHeader, senderAddress } from '@/lib/contact-center/auto-reply-guard';

describe('the Contact Center does not acknowledge automatic mail', () => {
  it.each([
    ['an out-of-office (Auto-Submitted)', { 'Auto-Submitted': 'auto-replied' }],
    ['a generated notice (Auto-Submitted, any case)', { 'auto-submitted': 'Auto-Generated' }],
    ['a responder marker (X-Autoreply)', { 'X-Autoreply': 'yes' }],
    ['bulk mail (Precedence)', { Precedence: 'bulk' }],
    ['a mailing list (List-Id)', { 'List-Id': 'Class 3B <class3b.school.example>' }],
    ['a sender that asks for no responses', { 'X-Auto-Response-Suppress': 'OOF, AutoReply' }],
    ['a raw SendGrid header block', { headers: 'Received: from x\r\nAuto-Submitted:\r\n auto-replied\r\nSubject: Hello' }],
    ['a bounce from the mail daemon', { from: 'Mail Delivery System <MAILER-DAEMON@school.example>' }],
    ['a no-reply sender', { from: 'School <no-reply@school.example>' }],
    ['another family address', { from: 'Neighbours <neighbours@bubaly.com>' }],
  ])('files %s and sends nothing back', async (_label, extra) => {
    expect((await deliver(extra as Record<string, string>)).status).toBe(200);
    expect(inbound()).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(outbound()).toEqual([]);
  });

  it('acknowledges a redelivered message once', async () => {
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect(inbound()).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(outbound()).toHaveLength(1);
  });

  it('marks its own acknowledgement as automatic, so the other side does not answer it', async () => {
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0][0].headers).toEqual({ 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' });
  });

  it('control: a person\'s mail, and mail that says Auto-Submitted: no, are acknowledged', async () => {
    expect((await deliver({ 'Auto-Submitted': 'no' })).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(SENDER);
  });
});

describe('the guard itself', () => {
  it('reads a header from fields or from a folded raw block, case-insensitively', () => {
    expect(inboundHeader({ 'PRECEDENCE': 'List' }, 'precedence')).toBe('List');
    expect(inboundHeader({ headers: 'A: 1\nList-Unsubscribe:\n <mailto:x@y>' }, 'List-Unsubscribe')).toBe('<mailto:x@y>');
    expect(inboundHeader({}, 'Auto-Submitted')).toBeNull();
  });

  it('takes the bare address from a display-name From', () => {
    expect(senderAddress('Teacher <Teacher@School.example>')).toBe('teacher@school.example');
    expect(senderAddress('teacher@school.example')).toBe('teacher@school.example');
    expect(senderAddress('')).toBeNull();
  });

  it('answers null for ordinary mail, and a reason for everything else', () => {
    expect(autoReplyRefusal({}, SENDER)).toBeNull();
    expect(autoReplyRefusal({ 'Auto-Submitted': 'no' }, SENDER)).toBeNull();
    expect(autoReplyRefusal({ Precedence: 'first-class' }, SENDER)).toBeNull();
    expect(autoReplyRefusal({}, null)).toBe('no_reply_sender');
    expect(autoReplyRefusal({}, 'bounces+123@lists.example')).toBe('no_reply_sender');
    expect(autoReplyRefusal({}, 'x@mail.bubaly.com')).toBe('bubaly_sender');
  });
});
