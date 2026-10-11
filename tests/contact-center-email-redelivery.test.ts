// Real email route, intake and receipts; synthetic storage and delivery.
// A redelivered email replies once, and one Message-Id addressed to two
// families is filed for both.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), sendEmail: vi.fn(), concierge: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/server/email', async original => ({
  ...await original<typeof import('@/lib/server/email')>(), sendEmail: mocks.sendEmail,
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: vi.fn(() => { throw new Error('Unexpected planner call'); }) }));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: () => false,
  sendSmsWithReceipt: vi.fn(() => { throw new Error('Unexpected provider call'); }),
}));

const OURS = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';
const SENDER = 'Teacher <teacher@school.example>';
let db: ReturnType<typeof createInMemorySupabase>;

function request(to = 'Ours <ours@bubaly.com>', messageId = '<shared-list-message@school.example>') {
  return new NextRequest('https://bubaly.example/api/contact-center/email', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': 'synthetic-inbound-secret' },
    body: JSON.stringify({ to, from: SENDER, subject: 'Hello', text: 'A simple note.', messageId }),
  });
}
const deliver = async (to?: string, messageId?: string) => (await import('@/app/api/contact-center/email/route')).POST(request(to, messageId));
const rows = (familyId: string, direction: 'inbound' | 'outbound') =>
  db.table('family_inbox_messages').filter(row => row.family_id === familyId && row.direction === direction);

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
  db.seed('families', [{ id: OURS, name: 'Ours', timezone: 'UTC' }, { id: THEIRS, name: 'Theirs', timezone: 'UTC' }]);
  db.seed('subscriptions', [{ family_id: OURS, plan: 'plus', status: 'active' }, { family_id: THEIRS, plan: 'plus', status: 'active' }]);
  db.seed('family_contact_channels', [
    { id: 'channel-ours', family_id: OURS, email_local: 'ours', ai_concierge_enabled: true, forward_to_phone: null },
    { id: 'channel-theirs', family_id: THEIRS, email_local: 'theirs', ai_concierge_enabled: true, forward_to_phone: null },
  ]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'other', summary: 'Field trip Friday', reply: 'Thanks, received.', aiUsed: false });
  mocks.sendEmail.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('email auto-reply is once per message', () => {
  it('a redelivered email gets no second reply and no second outbound row', async () => {
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(rows(OURS, 'outbound')).toHaveLength(1);
    expect(rows(OURS, 'inbound')).toHaveLength(1);
  });

  it('a different message from the same sender is still answered (control)', async () => {
    expect((await deliver(undefined, '<first@school.example>')).status).toBe(200);
    expect((await deliver(undefined, '<second@school.example>')).status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(rows(OURS, 'outbound')).toHaveLength(2);
  });
});

describe('a Message-Id shared by two families', () => {
  it('files the distribution-list copy for each family', async () => {
    expect((await deliver('Ours <ours@bubaly.com>')).status).toBe(200);
    expect((await deliver('Theirs <theirs@bubaly.com>')).status).toBe(200);
    expect(rows(OURS, 'inbound')).toHaveLength(1);
    expect(rows(THEIRS, 'inbound')).toHaveLength(1);
    expect(rows(OURS, 'inbound')[0].provider_ref).not.toBe(rows(THEIRS, 'inbound')[0].provider_ref);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a sender reusing a Message-Id at another family cannot suppress this family\'s copy', async () => {
    expect((await deliver('Theirs <theirs@bubaly.com>', '<victim-id@school.example>')).status).toBe(200);
    expect((await deliver('Ours <ours@bubaly.com>', '<victim-id@school.example>')).status).toBe(200);
    expect(rows(OURS, 'inbound')).toHaveLength(1);
    expect(rows(OURS, 'inbound')[0].body).toBe('A simple note.');
  });
});
