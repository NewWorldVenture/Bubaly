import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPendingPushes } from '@/lib/server/push';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

// PUSH-004. The dispatcher saves a cursor, then claims each later batch with a
// compare-and-set on it: `.eq('value', stored.value)`. postgrest-js puts
// `eq.${value}` in the URL, so the stored object reached PostgREST as
// "[object Object]" and was refused (22P02 invalid input syntax for type
// json). The first run, with no cursor yet, upserted and worked; every run
// after it threw "Push cursor write failed" and sent nothing. Found by running
// /api/cron/notifications twice against the local stack for the MAIN-F-014
// retest. The shared fixture compared `.eq()` by identity, which is why the
// suite never saw it; it now treats the value as PostgREST does.

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

const NOW = new Date('2026-09-28T12:00:00Z');
const row = (id: number, created: string): PushFixtureRow => ({
  id: notificationId(id), family_id: 'family-a', user_id: 'healthy', title: `notice ${id}`, body: '',
  pushed_at: null, send_at: NOW.toISOString(), created_at: created,
});

beforeEach(() => {
  provider.send.mockReset().mockResolvedValue({ statusCode: 201 });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a push run after the first still sends', () => {
  it('claims the stored cursor on the second run and delivers the new notification', async () => {
    const f = pushDispatchDb({
      notifications: [row(1, '2026-09-28T11:00:00.000000+00:00')],
      push_devices: [{ id: 'web', user_id: 'healthy', enabled: true, provider: 'webpush', endpoint: 'https://push.example.test/d', p256dh: 'k', auth: 'a' }],
      family_members: [], family_ai_settings: [], user_preferences: [],
    });
    const first = await dispatchPendingPushes(f.db, { now: NOW });
    expect(first.result.sent).toBe(1);
    expect(f.tables.app_settings).toHaveLength(1);

    f.tables.notifications.push(row(2, '2026-09-28T11:30:00.000000+00:00'));
    const second = await dispatchPendingPushes(f.db, { now: NOW });
    expect(second.result.sent).toBe(1);
    expect((f.tables.app_settings[0].value as { id: string }).id).toBe(notificationId(2));
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('the fixture refuses an object where PostgREST would (guards the guard)', async () => {
    const f = pushDispatchDb({ app_settings: [{ key: 'k', value: { version: 1 } }] } as never);
    const query = f.db.from('app_settings' as never) as unknown as {
      update: (v: unknown) => { eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => { select: (c: string) => { maybeSingle: () => Promise<{ error: { code: string } | null }> } } } };
    };
    const refused = await query.update({ updated_at: 'now' }).eq('key', 'k').eq('value', { version: 1 }).select('key').maybeSingle();
    expect(refused.error?.code).toBe('22P02');
    const f2 = pushDispatchDb({ app_settings: [{ key: 'k', value: { version: 1 } }] } as never);
    const q2 = f2.db.from('app_settings' as never) as unknown as typeof query;
    const accepted = await q2.update({ updated_at: 'now' }).eq('key', 'k').eq('value', JSON.stringify({ version: 1 })).select('key').maybeSingle();
    expect(accepted.error).toBeNull();
  });
});
