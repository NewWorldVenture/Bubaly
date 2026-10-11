import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPushCampaignAction } from '@/app/(app)/admin/marketing/push/actions';
import { dispatchPendingPushes, sendPushToUser, sendPushToUsers } from '@/lib/server/push';
import { POST as testPush } from '@/app/api/push/test/route';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: state.send, nativePushConfigured: () => ({ fcm: true, apns: false }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}`); },
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => ({ id: 'child' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

const payload = { title: 'Fixture push', body: 'Body', url: '/dashboard' };
const NOW = new Date('2026-09-12T12:00:00Z');
const counts = (overrides: PushFixtureRow = {}) => ({ sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0, ...overrides });
const device = (user: string, id = user) => ({ id, user_id: user, enabled: true, provider: 'fcm', token: `${user}-fixture-token` });
function fixture() {
  const f = pushDispatchDb({
    marketing_push_campaigns: [{ id: 'campaign', title: 'Fixture campaign', body: 'Body', url: '/dashboard', status: 'draft', deleted_at: null, recipients: 0, sent: 0, failed: 0, skipped: 0 }],
    push_devices: [device('child')], profiles: [{ id: 'child', email: 'child@example.test' }], marketing_suppressions: [],
    family_members: [{ id: 'member-child', user_id: 'child', family_id: 'family', role: 'child', is_active: true }],
    family_ai_settings: [{ family_id: 'family', child_channels: { push: true } }],
    user_preferences: [{ user_id: 'child', push_enabled: true }],
    notifications: [{ id: notificationId(1), family_id: 'family', user_id: 'child', title: 'Notice', body: '', pushed_at: null, created_at: NOW.toISOString(), send_at: NOW.toISOString() }],
  });
  state.db = f.db;
  return f;
}

beforeEach(() => {
  state.send.mockReset().mockResolvedValue('sent'); state.audit.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ''); vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('all public push senders enforce consent', () => {
  it.each(['recipient', 'parent', 'both'])('withholds direct and batch pushes for %s opt-out', async mode => {
    const f = fixture();
    if (mode !== 'parent') f.tables.user_preferences[0].push_enabled = false;
    if (mode !== 'recipient') f.tables.family_ai_settings[0].child_channels = { push: false };
    expect(await sendPushToUser(f.db, 'child', payload)).toEqual(counts({ withheld: 1 }));
    expect(await sendPushToUsers(f.db, ['child', 'child'], payload)).toEqual(counts({ withheld: 1 }));
    expect(state.send).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.table === 'push_devices')).toBe(false);
  });

  it('resolves consent once per public batch, deduplicating users and retaining adult/teen delivery', async () => {
    const f = fixture();
    f.tables.family_ai_settings[0].child_channels = { push: false };
    for (const [user, role] of [['parent', 'parent'], ['teen', 'teen']] as const) {
      f.tables.push_devices.push(device(user));
      f.tables.family_members.push({ user_id: user, family_id: 'family', role, is_active: true });
    }
    expect(await sendPushToUsers(f.db, ['child', 'parent', 'teen', 'parent'], payload)).toEqual(counts({ sent: 2, withheld: 1 }));
    expect(state.send.mock.calls.map(call => call[1])).toEqual(['parent-fixture-token', 'teen-fixture-token']);
    // One complete policy read includes its empty terminal page; preferences
    // retain their existing single-query batch behavior.
    for (const table of ['family_members', 'family_ai_settings']) expect(f.calls.filter(call => call.table === table).map(call => call.count)).toEqual([1, 0]);
    expect(f.calls.filter(call => call.table === 'user_preferences')).toHaveLength(1);
  });

  it('skips consent/device queries for a genuinely empty batch', async () => {
    const f = fixture();
    expect(await sendPushToUsers(f.db, [], payload)).toEqual(counts());
    expect(f.calls).toEqual([]); expect(state.send).not.toHaveBeenCalled();
  });

  it('bounds consent reads to 200 distinct recipients per chunk', async () => {
    const f = fixture();
    const ids = Array.from({ length: 401 }, (_, index) => `recipient-${index}`);
    f.tables.user_preferences = ids.map(user_id => ({ user_id, push_enabled: false }));
    expect(await sendPushToUsers(f.db, [...ids, ...ids.slice(0, 5)], payload)).toEqual(counts({ withheld: 401 }));
    expect(f.calls.filter(call => call.table === 'user_preferences').map(call => call.count)).toEqual([200, 200, 1]);
    // Each 200-recipient public batch now uses 100-ID child-policy chunks:
    // two, two, and one. Each empty chunk terminates on its first response.
    expect(f.calls.filter(call => call.table === 'family_members').map(call => call.count)).toEqual([0, 0, 0, 0, 0]);
    expect(state.send).not.toHaveBeenCalled();
  });

  it('does not begin delivery if a later consent chunk fails', async () => {
    const f = fixture();
    const ids = ['child', ...Array.from({ length: 200 }, (_, index) => `recipient-${index}`)];
    f.faults.add('user_preferences:select:2');
    await expect(sendPushToUsers(f.db, ids, payload)).rejects.toThrow('Push preference read failed');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.table === 'push_devices')).toBe(false);
  });

  it('keeps withheld recipients distinct from unconfigured devices and resolves queue opt-outs', async () => {
    const f = fixture();
    f.tables.family_ai_settings[0].child_channels = { push: false };
    f.tables.push_devices.push(device('parent'));
    f.tables.family_members.push({ user_id: 'parent', family_id: 'family', role: 'parent', is_active: true });
    f.tables.notifications[0].user_id = null;
    state.send.mockResolvedValue('unconfigured');
    expect(await sendPushToUsers(f.db, ['child', 'parent'], payload)).toEqual(counts({ skipped: 1, withheld: 1 }));
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ skipped: 1, withheld: 1 }));
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    state.send.mockResolvedValue('sent');
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ sent: 1, withheld: 1 }));
    expect(f.stamps).toEqual([notificationId(1)]);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts());
  });

  it('does not repeat consent reads for each queued notification', async () => {
    const f = fixture();
    f.tables.notifications = Array.from({ length: 20 }, (_, index) => ({ ...f.tables.notifications[0], id: notificationId(index + 1) }));
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(20);
    // One active-roster read and one child-role policy read, each with its
    // empty terminal page, independent of the twenty queued notifications.
    expect(f.calls.filter(call => call.table === 'family_members').map(call => call.count)).toEqual([1, 0, 1, 0]);
    expect(f.calls.filter(call => call.table === 'family_ai_settings').map(call => call.count)).toEqual([1, 0]);
    expect(f.calls.filter(call => call.table === 'user_preferences')).toHaveLength(1);
  });

  it.each(['recipient', 'parent'])('returns a non-success own-device test result for %s opt-out', async mode => {
    const f = fixture();
    if (mode === 'recipient') f.tables.user_preferences[0].push_enabled = false;
    else f.tables.family_ai_settings[0].child_channels = { push: false };
    const response = await testPush();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, result: counts({ withheld: 1 }) });
    expect(state.send).not.toHaveBeenCalled();
  });
});

describe('actual marketing action through the consent-aware sender', () => {
  // Marketing push is opt-in and never reaches a minor's account
  // (lib/marketing/push-audience.ts), so the campaign tests use the fixture
  // account as an ADULT who opted in; the child case is pinned separately.
  const optedIn = { marketingPush: true };
  function marketingFixture() {
    const f = fixture();
    f.tables.family_members[0].role = 'parent';
    f.tables.user_preferences[0].notification_prefs = optedIn;
    return f;
  }

  it('does not send on recipient opt-out and records withheld accounting', async () => {
    const f = marketingFixture();
    f.tables.user_preferences[0].push_enabled = false;
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', recipients: 1, sent: 0, failed: 0, skipped: 1 });
    expect(state.audit.mock.calls[0][1].metadata).toEqual({
      attemptId: expect.any(String), recipients: 1, sent: 0, failed: 0,
      withheld: 1, deviceSkipped: 0, pruned: 0,
    });
  });

  it.each([{ push: true }, {}])('never sends a marketing campaign to a child account (child_channels %o), even one marked opted in', async channels => {
    const f = fixture();
    f.tables.user_preferences[0].notification_prefs = optedIn;
    f.tables.family_ai_settings[0].child_channels = channels;
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', recipients: 0, sent: 0 });
  });

  it.each(['family_members', 'user_preferences'])('fails the campaign on a returned %s policy read error and sends only after recovery', async table => {
    const f = marketingFixture();
    f.faults.add(`${table}:select`);
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow('Could not send the push campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'failed', sent: 0, skipped: 0 });
    f.faults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', sent: 1, failed: 0, skipped: 0 });
  });

  it.each(['family_members', 'user_preferences'])('does not send or mark sent after a thrown %s policy read', async table => {
    const f = marketingFixture();
    f.thrownFaults.add(`${table}:select`);
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow('Could not send the push campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0].status).toBe('failed');
  });

  it('preserves recipient suppression, device deduplication and independent adult delivery', async () => {
    const f = fixture();
    f.tables.user_preferences[0].notification_prefs = optedIn;
    f.tables.push_devices.push(device('parent'), device('parent', 'second-device'), device('suppressed'));
    f.tables.family_members.push({ id: 'member-parent', user_id: 'parent', family_id: 'family', role: 'parent', is_active: true });
    f.tables.user_preferences.push({ user_id: 'parent', push_enabled: true, notification_prefs: optedIn },
      { user_id: 'suppressed', push_enabled: true, notification_prefs: optedIn });
    f.tables.profiles.push({ id: 'parent', email: 'parent@example.test' }, { id: 'suppressed', email: 'suppressed@example.test' });
    f.tables.marketing_suppressions.push({ email: 'suppressed@example.test' });
    await sendPushCampaignAction('campaign');
    // The child is not in the audience at all; the parent's two devices are.
    expect(state.send.mock.calls.map(call => call[1])).toEqual(['parent-fixture-token', 'parent-fixture-token']);
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ recipients: 1, sent: 2, skipped: 0 });
    expect(state.audit.mock.calls[0][1].metadata).toMatchObject({ withheld: 0, deviceSkipped: 0 });
  });

  it('preserves zero-recipient campaign completion without inventing skipped deliveries', async () => {
    const f = fixture();
    f.tables.push_devices = [];
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', recipients: 0, sent: 0, failed: 0, skipped: 0 });
    expect(state.audit.mock.calls[0][1].metadata).toMatchObject({ withheld: 0, deviceSkipped: 0 });
  });
});
