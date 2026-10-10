// A marketing push campaign whose server action was killed mid-send (function
// timeout, worker crash) never reaches its catch block, so the row stayed
// 'sending' for good: canSendPush and canDeletePush both refuse 'sending', and
// no action could acknowledge it. The same permanent state was written on
// purpose when the results could not be saved (phase 'unknown').
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { pushDispatchDb } from './helpers/push-dispatch-db';
import { getMessages, translate } from '@/lib/i18n/messages';
import { canDeletePush, canSendPush, needsPushReview, PUSH_ATTEMPT_STALE_MS, staleSendingResolution } from '@/lib/marketing/push';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: state.send, nativePushConfigured: () => ({ fcm: true, apns: false }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params) }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}`); },
}));
const actions = await import('@/app/(app)/admin/marketing/push/actions');
const { default: PushPage } = await import('@/app/(app)/admin/marketing/push/page');

const NOW = Date.parse('2026-09-12T12:00:00Z');
const STALE_AT = new Date(NOW - PUSH_ATTEMPT_STALE_MS - 60_000).toISOString();
const FRESH_AT = new Date(NOW - 60_000).toISOString();
const delivery = (phase: string) => ({ push_delivery: { version: 1, attemptId: 'attempt-1', phase } });

function fixture(phase: string, updatedAt: string) {
  const f = pushDispatchDb({
    marketing_push_campaigns: [{ id: 'campaign', title: 'Stuck fixture', status: 'sending', deleted_at: null,
      recipients: 0, sent: 0, failed: 0, skipped: 0, metadata: delivery(phase), updated_at: updatedAt, created_at: updatedAt }],
    push_devices: [{ id: 'device-a', user_id: 'user-a', enabled: true, provider: 'fcm', token: 'fixture-token-a' }],
    profiles: [{ id: 'user-a', email: 'user@example.test' }],
    user_preferences: [{ user_id: 'user-a', push_enabled: true, notification_prefs: { marketingPush: true } }],
    marketing_suppressions: [], family_members: [], family_ai_settings: [], notifications: [],
  });
  state.db = f.db;
  return f;
}
const row = (f: ReturnType<typeof fixture>) => f.tables.marketing_push_campaigns[0] as { status: string; metadata: unknown; deleted_at: unknown };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.send.mockReset().mockResolvedValue('sent'); state.audit.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ''); vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a stuck push campaign can be resolved', () => {
  it('a stale preparing attempt never reached a provider, so it becomes retryable and sends once', async () => {
    const f = fixture('preparing', STALE_AT);
    expect(renderToStaticMarkup(await PushPage())).toContain('Resolve stuck delivery');
    await actions.resolveStalePushCampaignAction('campaign');
    expect(row(f)).toMatchObject({ status: 'failed', metadata: { push_delivery: { phase: 'preflight_failed', previousPhase: 'preparing' } } });
    expect(canSendPush(row(f).status, row(f).metadata)).toBe(true);
    await actions.sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it.each(['dispatching', 'unknown'])('a %s attempt that may have reached devices is recorded as reviewed, deletable, and never re-sent', async phase => {
    const f = fixture(phase, STALE_AT);
    await actions.resolveStalePushCampaignAction('campaign');
    expect(row(f)).toMatchObject({ status: 'failed', metadata: { push_delivery: { phase: 'reviewed', previousPhase: phase } } });
    expect(canSendPush(row(f).status, row(f).metadata)).toBe(false);
    expect(canDeletePush(row(f).status, row(f).metadata)).toBe(true);
    expect(needsPushReview(row(f))).toBe(false);
    await actions.sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(await PushPage())).toContain('Delivery outcome unknown');
    await actions.deletePushCampaignAction('campaign');
    expect(row(f).deleted_at).not.toBeNull();
  });

  it('leaves an attempt that may still be running alone', async () => {
    const f = fixture('dispatching', FRESH_AT);
    expect(staleSendingResolution('sending', delivery('dispatching'), FRESH_AT, NOW)).toBeNull();
    expect(renderToStaticMarkup(await PushPage())).not.toContain('Resolve stuck delivery');
    await actions.resolveStalePushCampaignAction('campaign');
    expect(row(f)).toMatchObject({ status: 'sending', metadata: delivery('dispatching') });
  });

  it('resolves nothing that is not sending', () => {
    for (const status of ['draft', 'sent', 'failed']) {
      expect(staleSendingResolution(status, delivery('unknown'), STALE_AT, NOW)).toBeNull();
    }
  });
});
