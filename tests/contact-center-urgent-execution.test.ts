import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { attemptUrgentDelivery, captureInboundWithUrgency, drainUrgentDeliveries } from '@/lib/contact-center/urgent-delivery';
import { recordInboundMessage } from '@/lib/contact-center/server';
import { GET } from '@/app/api/cron/contact-center-urgent/route';

const mocks = vi.hoisted(() => ({ send: vi.fn(), configured: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: mocks.configured, sendSmsWithReceipt: mocks.send }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => `Translated: ${key}` }));
const FAMILY = '11111111-1111-4111-8111-111111111111';
const SID = `SM${'1'.repeat(32)}`;
const input = { familyId: FAMILY, channel: 'sms' as const, providerRef: 'urgent-test', to: '+15555550100', body: 'Urgent help', aiSummary: 'Urgent help', aiIntent: 'urgent' };
let db: ReturnType<typeof createInMemorySupabase>;
const admin = () => db as unknown as Parameters<typeof captureInboundWithUrgency>[0];
const resultError = { data: null, error: { code: '08006', message: 'Synthetic storage failure', details: null, hint: null }, count: null, status: 503, statusText: 'Unavailable' };

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], notifications: [['id']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound' }, notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  db.seed('families', [{ id: FAMILY }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: input.to, forward_to_phone: '+15555550200' }]);
  mocks.admin.mockReturnValue(db); mocks.configured.mockReturnValue(true);
  mocks.send.mockResolvedValue({ kind: 'accepted', messageSid: SID, providerStatus: 'queued' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const run = async () => {
  const captured = await captureInboundWithUrgency(admin(), input);
  return attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY);
};

describe('urgent delivery durable transitions', () => {
  it('fails before capture if the recovery receipt cannot be saved', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      if (table === 'ai_tool_calls') query.insert = (() => { throw new Error('Synthetic write failure'); }) as typeof query.insert;
      return query;
    }) as typeof db.from);
    await expect(captureInboundWithUrgency(admin(), input)).rejects.toThrow('Synthetic write failure');
    expect(db.table('family_inbox_messages')).toHaveLength(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('recovers a crash before the first inbox insert from persisted inputs', async () => {
    const from = db.from.bind(db);
    const outage = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      if (table === 'family_inbox_messages') query.insert = (() => { throw new Error('Synthetic process interruption'); }) as typeof query.insert;
      return query;
    }) as typeof db.from);
    await expect(captureInboundWithUrgency(admin(), input)).rejects.toThrow('Synthetic process interruption');
    expect(db.table('ai_tool_calls')).toHaveLength(1); expect(db.table('family_inbox_messages')).toHaveLength(0);
    outage.mockRestore();
    expect(await drainUrgentDeliveries(admin())).toMatchObject({ accepted: 1, failed: 0 });
    expect(db.table('family_inbox_messages')).toHaveLength(1); expect(db.table('notifications')).toHaveLength(1);
  });
  it('holds historical capture without a receipt as unknown rather than guessing it unsent', async () => {
    await recordInboundMessage(admin(), input);
    expect(await run()).toBe('legacy_unknown');
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'failed', error: 'Translated: contactUrgent.legacyUnknown', outputs: { phase: 'legacy_unknown', drain: false } });
    expect(mocks.send).not.toHaveBeenCalled(); expect(db.table('notifications')).toHaveLength(0);
  });
  it('rejects a global provider-ref collision with a different family before queuing', async () => {
    db.seed('family_inbox_messages', [{ family_id: 'other', channel: 'sms', provider_ref: input.providerRef }]);
    await expect(captureInboundWithUrgency(admin(), input)).rejects.toThrow('Inbound identity mismatch');
    expect(db.table('ai_tool_calls')).toHaveLength(0); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('concurrent callback and drain preserve the in-flight claim and send once', async () => {
    const captured = await captureInboundWithUrgency(admin(), input);
    let release!: (result: unknown) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    const revision = (db.table('ai_tool_calls')[0].outputs as { revision: string }).revision;
    expect(await attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY)).toBe('unknown');
    expect((db.table('ai_tool_calls')[0].outputs as { revision: string }).revision).toBe(revision);
    release({ kind: 'accepted', messageSid: SID, providerStatus: 'queued' });
    expect(await first).toBe('accepted');
    expect(mocks.send).toHaveBeenCalledOnce(); expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', outputs: { providerSid: SID } });
  });
  it('holds confirmed acceptance when final receipt persistence fails; no age-based takeover', async () => {
    const from = db.from.bind(db);
    const outage = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table), update = query.update.bind(query);
      query.update = ((patch: Record<string, unknown>) => {
        const updated = update(patch);
        if (table === 'ai_tool_calls' && (patch.outputs as { phase?: string })?.phase === 'accepted') updated.maybeSingle = async () => resultError;
        return updated;
      }) as typeof query.update;
      return query;
    }) as typeof db.from);
    expect(await run()).toBe('failed');
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'reserved', outputs: { phase: 'dispatching', drain: true } });
    outage.mockRestore();
    expect(await drainUrgentDeliveries(admin(), { now: new Date(Date.now() + 86_400_000) })).toMatchObject({ unknown: 1, accepted: 0 });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('keeps notification read/push/email markers through forced repair and replay', async () => {
    expect(await run()).toBe('accepted');
    Object.assign(db.table('notifications')[0], { is_read: true, sent_at: '2026-09-12T01:00:00Z', pushed_at: '2026-09-12T02:00:00Z' });
    const receipt = db.table('ai_tool_calls')[0];
    receipt.outputs = { ...(receipt.outputs as object), notificationDone: false, drain: true }; receipt.state = 'reserved';
    expect(await run()).toBe('accepted');
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('notifications')[0]).toMatchObject({ is_read: true, sent_at: '2026-09-12T01:00:00Z', pushed_at: '2026-09-12T02:00:00Z' });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('delivers in-app even when the family has no SMS fallback', async () => {
    db.table('family_contact_channels')[0].forward_to_phone = null;
    expect(await run()).toBe('in_app_only');
    expect(db.table('notifications')).toHaveLength(1); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('waits for provider configuration with no claimed external attempt, then recovers', async () => {
    mocks.configured.mockReturnValue(false);
    expect(await run()).toBe('pending');
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ attempt: 0, error: 'Translated: contactUrgent.smsUnavailable', outputs: { phase: 'queued' } });
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.configured.mockReturnValue(true);
    expect(await drainUrgentDeliveries(admin(), { now: new Date(Date.now() + 600_000) })).toMatchObject({ accepted: 1 });
  });
  it('checks current routing and fallback, so changed or revoked contact numbers cannot send', async () => {
    const captured = await captureInboundWithUrgency(admin(), input);
    db.table('family_contact_channels')[0].phone_number = '+15555550300';
    expect(await attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY)).toBe('rejected');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('fails closed on a transplanted receipt identity', async () => {
    const captured = await captureInboundWithUrgency(admin(), input);
    db.table('ai_tool_calls')[0].requested_by = 'member-pretending-to-be-system';
    expect(await attemptUrgentDelivery(admin(), captured.urgentReceiptId!, FAMILY)).toBe('failed');
    expect(mocks.send).not.toHaveBeenCalled(); expect(db.table('notifications')).toHaveLength(0);
  });
});

describe('bounded urgent drain and scheduler', () => {
  it('advances beyond held rows at the same timestamp and wraps without starving a healthy receipt', async () => {
    for (let index = 0; index < 3; index++) await captureInboundWithUrgency(admin(), { ...input, providerRef: `receipt-${index}` });
    const receipts = db.table('ai_tool_calls').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const receipt of receipts) receipt.created_at = '2026-09-12T00:00:00.000Z';
    for (const receipt of receipts.slice(0, 2)) receipt.outputs = { ...(receipt.outputs as object), phase: 'dispatching' };
    expect(await drainUrgentDeliveries(admin(), { limit: 1 })).toMatchObject({ examined: 1, unknown: 1 });
    expect(await drainUrgentDeliveries(admin(), { limit: 1 })).toMatchObject({ examined: 1, unknown: 1 });
    expect(await drainUrgentDeliveries(admin(), { limit: 1 })).toMatchObject({ examined: 1, accepted: 1 });
    expect(await drainUrgentDeliveries(admin(), { limit: 1 })).toMatchObject({ examined: 1, unknown: 1 });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('does not dispatch on an invalid durable cursor', async () => {
    await captureInboundWithUrgency(admin(), input);
    db.seed('app_settings', [{ key: 'contact_center.urgent_delivery:cursor', value: { id: 'injected-filter', createdAt: 'bad-date' } }]);
    await expect(drainUrgentDeliveries(admin())).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('surfaces cursor persistence failure after acceptance without repeating that accepted send', async () => {
    await captureInboundWithUrgency(admin(), input);
    const from = db.from.bind(db);
    const outage = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      if (table === 'app_settings') query.upsert = (() => { throw new Error('Synthetic cursor write unavailable'); }) as typeof query.upsert;
      return query;
    }) as typeof db.from);
    await expect(drainUrgentDeliveries(admin())).rejects.toThrow('Synthetic cursor write unavailable');
    outage.mockRestore();
    expect(await drainUrgentDeliveries(admin())).toMatchObject({ examined: 0 }); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('requires the scheduler secret before reading the queue', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    expect((await GET(new NextRequest('https://test.invalid/api/cron/contact-center-urgent'))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('returns unavailable for queued provider configuration and succeeds after recovery', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    await captureInboundWithUrgency(admin(), input); mocks.configured.mockReturnValue(false);
    const request = () => new NextRequest('https://test.invalid/api/cron/contact-center-urgent', { headers: { authorization: 'Bearer test-secret' } });
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ ok: false, pending: 1 });
    mocks.configured.mockReturnValue(true);
    const receipt = db.table('ai_tool_calls')[0]; receipt.outputs = { ...(receipt.outputs as object), retryAt: null };
    const healthy = await GET(request());
    expect(healthy.status).toBe(200); expect(await healthy.json()).toMatchObject({ ok: true, accepted: 1 });
  });
});
