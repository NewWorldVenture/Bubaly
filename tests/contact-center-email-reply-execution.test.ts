// Real email route, intake, urgent receipts and timeline; synthetic storage and delivery.
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

function request() {
  return new NextRequest('https://bubaly.example/api/contact-center/email', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': 'synthetic-inbound-secret' },
    body: JSON.stringify({
      to: 'Ours <ours@bubaly.com>', from: SENDER, subject: 'Hello', text: 'A simple note.', messageId: 'reply-fixture',
    }),
  });
}
const deliver = async () => (await import('@/app/api/contact-center/email/route')).POST(request());
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
  db.seed('family_contact_channels', [{
    id: 'channel-ours', family_id: FAMILY, email_local: 'ours', ai_concierge_enabled: true, forward_to_phone: null,
  }]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'A simple note', reply: REPLY, aiUsed: false });
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.translate.mockImplementation((key: string) => key === 'contactUrgent.replySaved' ? LOCALIZED : key);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Contact Center email auto-reply acceptance', () => {
  it.each([
    ['rejected', { ok: false }],
    ['skipped', { ok: true, skipped: true }],
    ['missing acceptance', undefined],
  ])('keeps intake without a false sent row when delivery is %s', async (_label, result) => {
    mocks.sendEmail.mockResolvedValue(result);
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0]).toMatchObject({ family_id: FAMILY, body: 'A simple note.', provider_ref: 'reply-fixture' });
    expect(outbound()).toEqual([]);
  });

  it('keeps intake without a false sent row when delivery throws', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('Synthetic provider response lost'));
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(inbound()).toHaveLength(1);
    expect(outbound()).toEqual([]);
  });

  it('sends with the resolved family reply address and stores the accepted plain-text reply', async () => {
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      to: SENDER, replyTo: 'ours@bubaly.com', subject: 'Re: Hello',
      html: '<p>Thank you &amp; see &lt;notes>.</p><p style="color:#888;font-size:12px">— Ours via ours@bubaly.com</p>',
    });
    expect(mocks.sendEmail.mock.calls[0][0].from).toMatch(/^"?Ours"? <ours@bubaly\.com>$/);
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0]).toMatchObject({ family_id: FAMILY, channel: 'email', to_addr: SENDER, body: REPLY, ai_handled: true, status: 'read' });
    expect(inbound()).toHaveLength(1);
  });

  it('writes no sent row while the provider result is still pending', async () => {
    let accept!: (result: { ok: boolean }) => void;
    mocks.sendEmail.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    const response = deliver();
    try {
      await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledOnce());
      expect(inbound()).toHaveLength(1);
      expect(outbound()).toEqual([]);
    } finally {
      accept({ ok: true });
      await response;
    }
    expect(outbound()).toHaveLength(1);
  });

  it('keeps the localized saved-intake reply for urgent mail and escapes reply and family text', async () => {
    db.table('families')[0].name = 'Ours & <Family>';
    mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent help', reply: 'Unconfirmed fallback delivery claim', aiUsed: false });
    expect((await deliver()).status).toBe(200);
    expect(mocks.translate).toHaveBeenCalledWith('contactUrgent.replySaved');
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      replyTo: 'ours@bubaly.com',
      html: '<p>Guardado &amp; pendiente &lt;revisar>.</p><p style="color:#888;font-size:12px">— Ours &amp; &lt;Family> via ours@bubaly.com</p>',
    });
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0].body).toBe(LOCALIZED);
    expect(db.table('ai_tool_calls')).toHaveLength(1);
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', outputs: { phase: 'in_app_only' } });
    expect(db.table('notifications')).toHaveLength(1);
  });
});
