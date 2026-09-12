import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { pushDispatchDb } from './helpers/push-dispatch-db';
import { getMessages, translate } from '@/lib/i18n/messages';
import { needsPushReview } from '@/lib/marketing/push';

// Independent consumer review. The real action, core sender, page and
// translation interpolation run against the existing stateful DB fixture.
const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), locale: 'en-US' as 'en-US' | 'fr-FR' }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: state.send, nativePushConfigured: () => ({ fcm: true, apns: false }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale), key, params) }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin', actorEmail: 'admin@example.test' }),
  logMarketingAudit: async () => {},
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}`); },
}));
import { deletePushCampaignAction, sendPushCampaignAction } from '@/app/(app)/admin/marketing/push/actions';
import PushPage from '@/app/(app)/admin/marketing/push/page';

function fixture() {
  const f = pushDispatchDb({
    marketing_push_campaigns: [{ id: 'campaign', title: 'Consumer review fixture', status: 'draft', deleted_at: null,
      recipients: 0, sent: 0, failed: 0, skipped: 0, metadata: {}, updated_at: '2026-09-12T12:00:00Z' }],
    push_devices: [{ id: 'device-a', user_id: 'user-a', enabled: true, provider: 'fcm', token: 'fixture-token-a' }],
    profiles: [{ id: 'user-a', email: 'user@example.test' }],
    marketing_suppressions: [], family_members: [], family_ai_settings: [], user_preferences: [], notifications: [],
  });
  state.db = f.db;
  return f;
}
beforeEach(() => {
  state.send.mockReset().mockResolvedValue('sent'); state.locale = 'en-US';
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ''); vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('marketing push consumer classification and interpolated units', () => {
  it('does not classify an intentionally withheld audience as a delivery problem', async () => {
    const f = fixture(); f.tables.user_preferences.push({ user_id: 'user-a', push_enabled: false });
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    const row = f.tables.marketing_push_campaigns[0];
    expect(row).toMatchObject({ status: 'sent', skipped: 1, metadata: { push_delivery: { phase: 'complete', withheldUsers: 1, skippedDevices: 0 } } });
    const html = renderToStaticMarkup(await PushPage());
    expect(html).toContain('Users excluded: 1');
    expect(html).toContain('Devices skipped: 0');
    expect(html).not.toContain('{withheld}');
    expect(needsPushReview(row as { status: string })).toBe(false);
    expect(html).toContain('Completed');
  });

  it('renders accepted devices and excluded users in French without calling a completed exclusion a failure', async () => {
    const f = fixture(); state.locale = 'fr-FR';
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', user_id: 'user-b' });
    f.tables.profiles.push({ id: 'user-b', email: 'second@example.test' });
    f.tables.user_preferences.push({ user_id: 'user-b', push_enabled: false });
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(await PushPage());
    expect(html).toContain('Acceptées par le fournisseur : 1');
    expect(html).toContain('Utilisateurs exclus : 1');
    expect(html).toContain('Appareils ignorés : 0');
    expect(html).not.toContain('{accepted}');
    expect(html).toContain('Terminé');
    expect(needsPushReview(f.tables.marketing_push_campaigns[0] as { status: string })).toBe(false);
  });
});

describe('marketing push outcome retention through the actual action and page', () => {
  // A denied action may reject or return without writing; the important
  // contract is durable retention plus no misleading Delete affordance.
  const attemptDelete = () => deletePushCampaignAction('campaign').catch(() => undefined);

  it('retains an active campaign while an issued provider request and a second device remain pending', async () => {
    const f = fixture();
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', token: 'fixture-token-b' });
    let release!: (value: string) => void;
    state.send.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = sendPushCampaignAction('campaign');
    try {
      await vi.waitFor(() => expect(state.send).toHaveBeenCalledTimes(1));
      expect(f.tables.marketing_push_campaigns[0]).toMatchObject({
        status: 'sending', metadata: { push_delivery: { phase: 'dispatching' } },
      });
      await attemptDelete();
      expect(f.tables.marketing_push_campaigns[0].deleted_at).toBeNull();
      const html = renderToStaticMarkup(await PushPage());
      expect(html).toContain('Consumer review fixture');
      expect(html).toContain('Review delivery');
      expect(html).not.toContain('>Delete</button>');
    } finally {
      release?.('sent');
      await pending;
    }
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({ status: 'sent', sent: 2, deleted_at: null });
    expect(renderToStaticMarkup(await PushPage())).toContain('Consumer review fixture');
  });

  it('retains the only visible review record after acceptance followed by a later query failure', async () => {
    const f = fixture();
    f.tables.profiles.push({ id: 'user-b', email: 'second@example.test' });
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'device-b', user_id: 'user-b' });
    state.send.mockImplementation(async () => {
      f.thrownFaults.add('push_devices:select');
      return 'sent';
    });
    await expect(sendPushCampaignAction('campaign')).rejects.toThrow();
    f.thrownFaults.clear();
    expect(f.tables.marketing_push_campaigns[0]).toMatchObject({
      status: 'sending', metadata: { push_delivery: { phase: 'unknown' } },
    });
    await attemptDelete();
    expect(f.tables.marketing_push_campaigns[0].deleted_at).toBeNull();
    const html = renderToStaticMarkup(await PushPage());
    expect(html).toContain('Consumer review fixture');
    expect(html).toContain('Review delivery');
    expect(html).not.toContain('>Delete</button>');
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it.each(['preparing', 'dispatching', 'unknown'])('retains a %s receipt even if the status field appears settled', async phase => {
    const f = fixture();
    Object.assign(f.tables.marketing_push_campaigns[0], {
      status: 'failed', metadata: { push_delivery: { version: 1, attemptId: 'existing-attempt', phase } },
    });
    await attemptDelete();
    expect(f.tables.marketing_push_campaigns[0].deleted_at).toBeNull();
    const html = renderToStaticMarkup(await PushPage());
    expect(html).toContain('Consumer review fixture');
    expect(html).not.toContain('>Delete</button>');
    expect(state.send).not.toHaveBeenCalled();
  });

  it.each(['draft', 'completed'])('still permits ordinary %s history deletion', async status => {
    const f = fixture();
    if (status === 'completed') await sendPushCampaignAction('campaign');
    expect(renderToStaticMarkup(await PushPage())).toContain('>Delete</button>');
    await deletePushCampaignAction('campaign');
    expect(f.tables.marketing_push_campaigns[0].deleted_at).toEqual(expect.any(String));
    expect(renderToStaticMarkup(await PushPage())).not.toContain('Consumer review fixture');
  });
});
