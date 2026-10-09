import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationHref } from '@/lib/notifications/actions';
import { deliverNotificationEmails } from '@/lib/server/notification-emails';
import { dispatchPendingPushes } from '@/lib/server/push';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const providers = vi.hoisted(() => ({ push: vi.fn(), email: vi.fn(), users: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: providers.push } }));
vi.mock('@/lib/email', () => ({ emailEnabled: () => true, sendReactEmail: providers.email }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: providers.users }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true }));

const NOW = new Date('2026-10-02T12:00:00Z');
const CONVERSATION = notificationId(800), MESSAGE = notificationId(801);
const row = (id: number, fields: PushFixtureRow = {}): PushFixtureRow => ({
  id: notificationId(id), family_id: 'family', user_id: 'recipient', type: 'system',
  title: 'New message', body: 'Open your conversation in Bubaly.',
  related_type: 'family_message', related_id: `${CONVERSATION}:${MESSAGE}`,
  pushed_at: null, sent_at: null, send_at: NOW.toISOString(), created_at: NOW.toISOString(), ...fields,
});
const fixture = (rows: PushFixtureRow[]) => pushDispatchDb({
  notifications: rows,
  push_devices: [{ id: 'device', user_id: 'recipient', enabled: true, provider: 'webpush', endpoint: 'https://push.example.test/device', p256dh: 'key', auth: 'auth' }],
  family_members: [{ id: 'member', family_id: 'family', user_id: 'recipient', role: 'parent', is_active: true }], family_ai_settings: [], user_preferences: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  providers.push.mockReset().mockResolvedValue({ statusCode: 201 });
  providers.email.mockReset().mockResolvedValue({ ok: true });
  providers.users.mockReset().mockResolvedValue({ users: [{ id: 'recipient', email: 'fixture@example.test', user_metadata: {} }], error: null });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('private in-app message notices', () => {
  it('opens the conversation, not the message or raw composite key', () => {
    expect(notificationHref({ related_type: 'family_message', related_id: `${CONVERSATION}:${MESSAGE}` }))
      .toBe(`/dashboard/messages?conversation=${CONVERSATION}`);
    expect(notificationHref({ related_type: 'family_message', related_id: 'javascript:invalid' })).toBe('/dashboard/messages');
  });

  it('excludes chat notices before the push batch limit without starving normal notices', async () => {
    const f = fixture([...Array.from({ length: 250 }, (_, i) => row(i + 1)), row(900, { related_type: null, title: 'Normal update' })]);
    expect(await dispatchPendingPushes(f.db, { now: NOW })).toMatchObject({ notifications: 1, result: { sent: 1 } });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).notifications).toBe(0);
    expect(providers.push).toHaveBeenCalledTimes(1);
    expect(JSON.parse(providers.push.mock.calls[0][1]).title).toBe('Normal update');
    expect(f.stamps).toEqual([notificationId(900)]);
    expect(f.tables.notifications.slice(0, 250).every(item => item.pushed_at === null)).toBe(true);
  });

  it('retains the chat exclusion on both sides of a saved push cursor wrap', async () => {
    const f = fixture([row(1, { related_type: 'calendar_event', title: 'First' }), row(2), row(3, { related_type: null, title: 'Last' })]);
    providers.push.mockRejectedValue(new Error('Provider unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await dispatchPendingPushes(f.db, { now: NOW, limit: 1 });
    expect(providers.push.mock.calls.map(call => JSON.parse(call[1]).title)).toEqual(['First', 'Last', 'First']);
    expect(f.stamps).toEqual([]);
  });

  it('does not email or stamp an in-app-only message backlog', async () => {
    const f = fixture(Array.from({ length: 600 }, (_, i) => row(i + 1)));
    expect(await deliverNotificationEmails(f.db)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(providers.email).not.toHaveBeenCalled();
    expect(providers.users).not.toHaveBeenCalled();
    expect(f.stamps).toEqual([]);
  });

  it('excludes chat before the email limit and still emails a normal notice behind the backlog', async () => {
    const f = fixture([...Array.from({ length: 600 }, (_, i) => row(i + 1)), row(900, { related_type: null, title: 'Normal update' })]);
    expect(await deliverNotificationEmails(f.db)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(providers.email).toHaveBeenCalledTimes(1);
    expect(providers.email.mock.calls[0][0].react.props.items).toEqual([{ title: 'Normal update', body: 'Open your conversation in Bubaly.', icon: expect.any(String) }]);
    expect(f.stamps).toEqual([notificationId(900)]);
    expect(f.tables.notifications.slice(0, 600).every(item => item.sent_at === null)).toBe(true);
  });
});
