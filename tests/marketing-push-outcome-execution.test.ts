import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { pushDispatchDb } from './helpers/push-dispatch-db';
import english from '@/lib/i18n/messages/en-US.json';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: state.send, nativePushConfigured: () => ({ fcm: true, apns: false }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => (english as Record<string, string>)[key] ?? key }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}`); },
}));
import { sendPushCampaignAction } from '@/app/(app)/admin/marketing/push/actions';
import PushPage from '@/app/(app)/admin/marketing/push/page';

function fixture() {
  const f = pushDispatchDb({
    marketing_push_campaigns: [{ id: 'campaign', title: 'Fixture', status: 'draft', deleted_at: null, recipients: 0, sent: 0, failed: 0, skipped: 0, metadata: { retained: true } }],
    push_devices: [{ id: 'device-a', user_id: 'user-a', enabled: true, provider: 'fcm', token: 'fixture-token-a' }],
    profiles: [{ id: 'user-a', email: 'user@example.test' }],
    marketing_suppressions: [], family_members: [], family_ai_settings: [], user_preferences: [], notifications: [],
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

describe('marketing push outcomes through the actual action, core sender and page', () => {
  it.each(['failed', 'unconfigured'])('does not report %s delivery as a sent campaign or invite a whole-campaign retry', async outcome => {
    const f = fixture(); state.send.mockResolvedValue(outcome);
    await sendPushCampaignAction('campaign');
    expect(f.tables.marketing_push_campaigns[0].status).toBe('failed');
    const html = renderToStaticMarkup(await PushPage());
    expect(html).toContain('Review delivery');
    expect(html).not.toContain('type="submit" class="inline-flex items-center gap-1 font-semibold');
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('preserves partial acceptance without calling it complete success', async () => {
    const f = fixture();
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', token: 'fixture-token-b' });
    state.send.mockResolvedValueOnce('sent').mockResolvedValueOnce('failed');
    await sendPushCampaignAction('campaign');
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'failed', sent: 1, failed: 1 });
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(2);
  });

  it('does not divide two device acceptances by one user in the actual page', async () => {
    const f = fixture();
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', token: 'fixture-token-b' });
    await sendPushCampaignAction('campaign');
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ sent: 2, recipients: 1 });
    const html = renderToStaticMarkup(await PushPage());
    expect(html).not.toContain('200%');
    expect(html).toContain('Provider accepted');
  });

  it('does not resend after a later query throws following one accepted device', async () => {
    const f = fixture();
    f.tables.profiles.push({ id: 'user-b', email: 'second@example.test' });
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', user_id: 'user-b' });
    state.send.mockImplementation(async () => {
      // Audience and all consent reads have finished; fail the next user's
      // device query after one real sender path has already accepted a device.
      f.thrownFaults.add('push_devices:select');
      return 'sent';
    });
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow();
    f.thrownFaults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(await PushPage())).toContain('Review delivery');
  });

  it('allows one provider attempt when two send actions race', async () => {
    const f = fixture();
    await Promise.all([sendPushCampaignAction('campaign'), sendPushCampaignAction('campaign')]);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.audit).toHaveBeenCalledTimes(1);
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', sent: 1 });
  });

  it('does not dispatch until the dispatch claim is saved, then permits a safe retry', async () => {
    const f = fixture();
    f.faults.add('marketing_push_campaigns:update:2');
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow();
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({
      status: 'failed', metadata: { push_delivery: { phase: 'preflight_failed' } },
    });
    f.faults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('retains an uncertain attempt when the final receipt write fails after provider acceptance', async () => {
    const f = fixture();
    f.faults.add('marketing_push_campaigns:update:3');
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({
      status: 'sending', metadata: { push_delivery: { phase: 'unknown' } },
    });
    f.faults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.audit).not.toHaveBeenCalled();
  });

  it('does not overwrite a replacement claim after an already-issued provider request completes', async () => {
    const f = fixture();
    state.send.mockImplementation(async () => {
      f.tables.marketing_push_campaigns[0].metadata = {
        push_delivery: { version: 1, attemptId: 'replacement', phase: 'unknown' },
      };
      return 'sent';
    });
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({
      status: 'sending', metadata: { push_delivery: { attemptId: 'replacement', phase: 'unknown' } },
    });
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('holds legacy failed campaigns whose prior provider outcome cannot be established', async () => {
    const f = fixture();
    Object.assign(f.tables.marketing_push_campaigns[0], { status: 'failed', sent: 1 });
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(f.tables.marketing_push_campaigns[0].status).toBe('failed');
    expect(renderToStaticMarkup(await PushPage())).toContain('Review delivery');
  });
});
