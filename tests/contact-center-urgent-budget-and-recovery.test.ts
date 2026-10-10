// Urgent receipts: SMS budget, intent upgraded on redelivery, refused provider
// credentials, and a post-send write that outlives the shared deadline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import {
  attemptUrgentDelivery, captureInboundWithUrgency, drainUrgentDeliveries, URGENT_SMS_PER_DAY, URGENT_SMS_PER_HOUR,
} from '@/lib/contact-center/urgent-delivery';
import { recordInboundMessage } from '@/lib/contact-center/server';

const mocks = vi.hoisted(() => ({ send: vi.fn(), configured: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: mocks.configured, sendSmsWithReceipt: mocks.send }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => `Translated: ${key}` }));
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TOOL = 'contact_center.urgent_delivery';
const SID = `SM${'1'.repeat(32)}`;
const input = { familyId: FAMILY, channel: 'email' as const, providerRef: 'urgent-budget', from: 'stranger@example.com',
  to: 'ours@bubaly.com', subject: 'Help', body: 'Urgent help', aiSummary: 'Urgent help', aiIntent: 'urgent' };
let db: ReturnType<typeof createInMemorySupabase>;
const admin = () => db as unknown as Parameters<typeof captureInboundWithUrgency>[0];
const run = async (overrides: Partial<typeof input> = {}) => {
  const captured = await captureInboundWithUrgency(admin(), { ...input, ...overrides });
  return attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY);
};
const receipt = (providerRef = input.providerRef) =>
  db.table('ai_tool_calls').find(row => (row.inputs as { providerRef?: string }).providerRef === providerRef)!;

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], notifications: [['id']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound' }, notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  db.seed('families', [{ id: FAMILY }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, email_local: 'ours', phone_number: null, forward_to_phone: '+15555550200' }]);
  mocks.configured.mockReturnValue(true);
  mocks.send.mockResolvedValue({ kind: 'accepted', messageSid: SID, providerStatus: 'queued' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('urgent SMS budget', () => {
  it('stops texting after the hourly budget and keeps the rest in-app', async () => {
    for (let index = 0; index < URGENT_SMS_PER_HOUR; index++) {
      expect(await run({ providerRef: `flood-${index}`, from: `sender-${index}@example.com` })).toBe('accepted');
    }
    expect(await run({ providerRef: 'flood-over', from: 'sender-over@example.com' })).toBe('in_app_only');
    expect(mocks.send).toHaveBeenCalledTimes(URGENT_SMS_PER_HOUR);
    expect(receipt('flood-over')).toMatchObject({ state: 'succeeded', error: 'Translated: contactUrgent.smsBudget',
      outputs: { phase: 'in_app_only', drain: false, providerSid: null } });
    expect(db.table('notifications')).toHaveLength(URGENT_SMS_PER_HOUR + 1);
    expect(db.table('family_inbox_messages')).toHaveLength(URGENT_SMS_PER_HOUR + 1);
  });

  it('enforces the daily cap with sends older than an hour', async () => {
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.seed('ai_tool_calls', Array.from({ length: URGENT_SMS_PER_DAY }, (_, index) => ({
      family_id: FAMILY, tool_name: TOOL, idempotency_key: `seeded-${index}`, locked_at: earlier,
      inputs: { from: `seeded-${index}@example.com` }, outputs: { phase: 'accepted', drain: false },
    })));
    expect(await run()).toBe('in_app_only');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('collapses repeated urgent messages from one sender into one SMS', async () => {
    expect(await run({ providerRef: 'same-1', from: 'Stranger <STRANGER@example.com>' })).toBe('accepted');
    expect(await run({ providerRef: 'same-2', from: 'stranger <stranger@example.com>' })).toBe('in_app_only');
    expect(await run({ providerRef: 'other-sender', from: 'teacher@school.example' })).toBe('accepted');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('a same-sender follow-up during an outage is still texted once credentials work', async () => {
    mocks.send.mockResolvedValueOnce({ kind: 'misconfigured' });
    expect(await run({ providerRef: 'outage-a' })).toBe('pending');
    // Credentials are fixed; A is still waiting for its retry, so nothing has
    // reached this sender yet and B must not be collapsed onto A's attempt.
    expect(await run({ providerRef: 'outage-b' })).toBe('accepted');
    expect(receipt('outage-b')).toMatchObject({ state: 'succeeded', outputs: { phase: 'accepted', providerSid: SID } });
    // A then drains and shares B's SMS: the sender got exactly one text.
    expect(await drainUrgentDeliveries(admin(), { now: new Date(Date.now() + 360_000) })).toMatchObject({ in_app_only: 1, accepted: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(receipt('outage-a')).toMatchObject({ state: 'succeeded', error: 'Translated: contactUrgent.smsBudget', outputs: { phase: 'in_app_only' } });
  });

  it('an outage backlog larger than the hourly budget is held for retry, not demoted to in-app only', async () => {
    mocks.send.mockResolvedValue({ kind: 'misconfigured' });
    for (let index = 0; index <= URGENT_SMS_PER_HOUR; index++) {
      expect(await run({ providerRef: `backlog-${index}`, from: `sender-${index}@example.com` })).toBe('pending');
    }
    expect(db.table('ai_tool_calls').every(row => (row.outputs as { phase: string; drain: boolean }).phase === 'queued' &&
      (row.outputs as { drain: boolean }).drain)).toBe(true);
    mocks.send.mockResolvedValue({ kind: 'accepted', messageSid: SID, providerStatus: 'queued' });
    // Once credentials work the budget is spent on texts actually sent.
    expect(await drainUrgentDeliveries(admin(), { limit: 20, now: new Date(Date.now() + 600_000) }))
      .toMatchObject({ accepted: URGENT_SMS_PER_HOUR, in_app_only: 1, pending: 0 });
  });

  it('sends Twilio rejected or asked to retry do not use up the budget', async () => {
    for (let index = 0; index < URGENT_SMS_PER_HOUR; index++) {
      mocks.send.mockResolvedValueOnce({ kind: 'rejected', code: 'provider_rejected' });
      expect(await run({ providerRef: `rejected-${index}`, from: `rejected-${index}@example.com` })).toBe('rejected');
    }
    mocks.send.mockResolvedValueOnce({ kind: 'retryable', code: 'rate_limited' });
    expect(await run({ providerRef: 'retry', from: 'retry@example.com' })).toBe('pending');
    expect(await run({ providerRef: 'genuine', from: 'genuine@example.com' })).toBe('accepted');
    expect(receipt('genuine')).toMatchObject({ outputs: { phase: 'accepted', providerSid: SID } });
  });

  it('sends that were accepted or whose outcome is unknown still exhaust the budget (control)', async () => {
    for (let index = 0; index < URGENT_SMS_PER_HOUR; index++) {
      if (index % 2) mocks.send.mockResolvedValueOnce({ kind: 'unknown' });
      await run({ providerRef: `spent-${index}`, from: `spent-${index}@example.com` });
    }
    expect(await run({ providerRef: 'spent-over', from: 'spent-over@example.com' })).toBe('in_app_only');
    expect(mocks.send).toHaveBeenCalledTimes(URGENT_SMS_PER_HOUR);
  });

  it('an unknown send outcome still collapses a same-sender repeat (control)', async () => {
    mocks.send.mockResolvedValueOnce({ kind: 'unknown' });
    expect(await run({ providerRef: 'unknown-1', from: 'repeat@example.com' })).toBe('unknown');
    expect(await run({ providerRef: 'unknown-2', from: 'repeat@example.com' })).toBe('in_app_only');
  });

  it('a family under the budget still texts (control)', async () => {
    expect(await run()).toBe('accepted');
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});

describe('intent upgraded to urgent on redelivery', () => {
  it('queues and escalates a row first filed non-urgent instead of parking it as legacy', async () => {
    await captureInboundWithUrgency(admin(), { ...input, aiIntent: 'other', aiSummary: 'A note' });
    expect(db.table('ai_tool_calls')).toHaveLength(0);
    expect(await run()).toBe('accepted');
    const row = db.table('family_inbox_messages')[0];
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(receipt()).toMatchObject({ state: 'succeeded', resource_id: row.id, error: null, outputs: { phase: 'accepted', drain: false } });
    expect(mocks.send).toHaveBeenCalledOnce(); expect(db.table('notifications')).toHaveLength(1);
  });

  it('still holds a receipt-less row that was itself filed urgent as legacy (control)', async () => {
    await recordInboundMessage(admin(), input);
    expect(await run()).toBe('legacy_unknown');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('refused provider credentials', () => {
  it('requeues with drain and no spent attempt, then delivers once configuration is fixed', async () => {
    mocks.send.mockResolvedValueOnce({ kind: 'misconfigured' });
    expect(await run()).toBe('pending');
    expect(receipt()).toMatchObject({ state: 'failed', attempt: 0, error: 'Translated: contactUrgent.smsUnavailable',
      outputs: { phase: 'queued', drain: true } });
    expect(await drainUrgentDeliveries(admin(), { now: new Date(Date.now() + 600_000) })).toMatchObject({ accepted: 1, rejected: 0 });
    expect(receipt()).toMatchObject({ state: 'succeeded', attempt: 1, outputs: { phase: 'accepted', providerSid: SID } });
  });
});

describe('post-send receipt write', () => {
  it('records an accepted send even when the shared deadline expired during the send', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table), abortSignal = query.abortSignal.bind(query);
      query.abortSignal = ((signal: AbortSignal) => {
        if (signal.aborted) throw new DOMException('Synthetic deadline', 'AbortError');
        return abortSignal();
      }) as typeof query.abortSignal;
      return query;
    }) as typeof db.from);
    const captured = await captureInboundWithUrgency(admin(), input);
    const deadline = new AbortController();
    mocks.send.mockImplementationOnce(async () => { deadline.abort(); return { kind: 'accepted', messageSid: SID, providerStatus: 'queued' }; });
    expect(await attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY, { signal: deadline.signal })).toBe('accepted');
    expect(receipt()).toMatchObject({ state: 'succeeded', outputs: { phase: 'accepted', providerSid: SID, drain: false } });
  });
});
