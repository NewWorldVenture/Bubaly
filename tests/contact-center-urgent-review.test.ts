// Independent INT-002 review regressions; real receipt/capture modules, synthetic storage/provider.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { attemptUrgentDelivery, captureInboundWithUrgency } from '@/lib/contact-center/urgent-delivery';

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => true, sendSmsWithReceipt: provider.send }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const FAMILY = '11111111-1111-4111-8111-111111111111';
let db: ReturnType<typeof createInMemorySupabase>;
beforeEach(() => {
  db = createInMemorySupabase({ uniques: { ai_tool_calls: [['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] }, defaults: {
    ai_tool_calls: { locked_at: null, finished_at: null, error: null },
    family_inbox_messages: { direction: 'inbound', ai_handled: false },
  } });
  db.seed('families', [{ id: FAMILY }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: '+15555550100', email_local: 'foo', forward_to_phone: '+15555550200' }]);
  provider.send.mockReset().mockResolvedValue({ kind: 'accepted', messageSid: `SM${'a'.repeat(32)}`, providerStatus: 'queued' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
function admin() { return db as unknown as Parameters<typeof captureInboundWithUrgency>[0]; }
async function capture(channel: 'sms' | 'email' = 'sms') {
  return captureInboundWithUrgency(admin(), { familyId: FAMILY, channel, providerRef: 'review-provider-ref', to: channel === 'sms' ? '+15555550100' : 'notfoo@bubaly.com', body: 'Urgent help', aiSummary: 'Urgent help', aiIntent: 'urgent' });
}

it('surfaces failed notification recovery while an external send is held', async () => {
  const filed = await capture();
  const row = db.table('ai_tool_calls')[0];
  row.outputs = { ...(row.outputs as object), phase: 'dispatching' };
  const revision = (row.outputs as { revision: string }).revision;
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    if (table === 'notifications') throw new Error('synthetic failed notification storage');
    return from(table);
  }) as typeof db.from);
  expect(await attemptUrgentDelivery(admin(), filed.urgentReceiptId!, FAMILY)).toBe('failed');
  expect((row.outputs as { revision: string }).revision).toBe(revision);
  expect(provider.send).not.toHaveBeenCalled();
});

it.each(['accepted', 'in_app_only'] as const)('completes the ledger after repairing an %s notification', async phase => {
  const filed = await capture();
  const row = db.table('ai_tool_calls')[0];
  row.outputs = { ...(row.outputs as object), phase, ...(phase === 'accepted' ? { providerSid: `SM${'b'.repeat(32)}`, providerStatus: 'queued' } : {}) };
  expect(await attemptUrgentDelivery(admin(), filed.urgentReceiptId!, FAMILY)).toBe(phase);
  expect(db.table('notifications')).toHaveLength(1);
  expect(db.table('ai_tool_calls')[0].state).toBe('succeeded');
  expect(db.table('ai_tool_calls')[0].outputs).toMatchObject({ notificationDone: true, drain: false });
  expect(provider.send).not.toHaveBeenCalled();
});

it('does not send against a changed email identity that only matches a suffix', async () => {
  db.table('family_contact_channels')[0].email_local = 'notfoo';
  const filed = await capture('email');
  db.table('family_contact_channels')[0].email_local = 'foo';
  expect(await attemptUrgentDelivery(admin(), filed.urgentReceiptId!, FAMILY)).toBe('rejected');
  expect(provider.send).not.toHaveBeenCalled();
});
