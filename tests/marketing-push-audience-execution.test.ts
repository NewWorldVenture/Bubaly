import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPushCampaignAction } from '@/app/(app)/admin/marketing/push/actions';
import { pushDispatchDb } from './helpers/push-dispatch-db';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), audit: vi.fn(), failure: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: state.send, nativePushConfigured: () => ({ fcm: true, apns: false }) }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string, error: unknown) => { state.failure(operation, error); throw new Error(`Could not ${operation}`); },
}));

const userId = (index: number) => `user-${String(index).padStart(5, '0')}`;
const device = (index: number, user = userId(index)) => ({ id: `device-${String(index).padStart(5, '0')}`, user_id: user, enabled: true, provider: 'fcm', token: user });
function fixture(users = 1, maxRows = 1000) {
  const f = pushDispatchDb({
    marketing_push_campaigns: [{ id: 'campaign', title: 'Fixture', status: 'draft', deleted_at: null, recipients: 0, sent: 0, failed: 0, skipped: 0 }],
    push_devices: Array.from({ length: users }, (_, i) => device(i)),
    profiles: Array.from({ length: users }, (_, i) => ({ id: userId(i), email: `${userId(i)}@example.test` })),
    marketing_suppressions: [], family_members: [], family_ai_settings: [], user_preferences: [], notifications: [],
  }, { maxRows });
  state.db = f.db;
  return f;
}
const campaign = (f: ReturnType<typeof fixture>) => f.tables.marketing_push_campaigns[0];
async function failsBeforeSending(f: ReturnType<typeof fixture>) {
  await expect(sendPushCampaignAction('campaign')).rejects.toThrow('Could not send the push campaign');
  expect(state.send).not.toHaveBeenCalled();
  expect(state.audit).not.toHaveBeenCalled();
  expect(campaign(f)).toMatchObject({ status: 'failed', sent: 0 });
}

beforeEach(() => {
  state.send.mockReset().mockResolvedValue('sent'); state.audit.mockReset().mockResolvedValue(undefined); state.failure.mockReset();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ''); vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('actual marketing action completes audience reads before delivery', () => {
  it('excludes a suppression beyond the database response cap', async () => {
    const f = fixture();
    f.tables.profiles[0].email = 'zz-target@example.test';
    f.tables.marketing_suppressions = [...Array.from({ length: 1000 }, (_, i) => ({ email: `a${String(i).padStart(4, '0')}@example.test` })), { email: 'zz-target@example.test' }];
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(campaign(f)).toMatchObject({ status: 'sent', recipients: 0, sent: 0 });
    expect(f.calls.filter(c => c.table === 'marketing_suppressions').map(c => c.count)).toEqual([200, 200, 200, 200, 200, 1, 0]);
  });

  it('delivers to the eligible user beyond the first 1000 devices, with bounded profile chunks', async () => {
    const f = fixture(1001);
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1001);
    expect(state.send.mock.calls.at(-1)?.[1]).toBe(userId(1000));
    expect(campaign(f)).toMatchObject({ status: 'sent', recipients: 1001, sent: 1001 });
    expect(f.calls.filter(c => c.table === 'profiles').map(c => c.count)).toEqual([200, 0, 200, 0, 200, 0, 200, 0, 200, 0, 1, 0]);
  });

  it('continues to empty under a response cap smaller than the requested page, including profiles', async () => {
    const f = fixture(5, 2);
    f.tables.marketing_suppressions = [0, 1, 2, 3, 4].map(i => ({ email: `${userId(i)}@example.test` }));
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    for (const table of ['push_devices', 'profiles', 'marketing_suppressions']) {
      expect(f.calls.filter(c => c.table === table).map(c => c.count)).toEqual([2, 2, 1, 0]);
      expect(f.calls.filter(c => c.table === table).every(c => c.limit === 200)).toBe(true);
    }
    expect(campaign(f)).toMatchObject({ recipients: 0, sent: 0 });
  });

  it('deduplicates users across device pages and preserves case/whitespace-insensitive suppression', async () => {
    const f = fixture(3, 2);
    f.tables.push_devices.push(device(3, userId(0)));
    f.tables.profiles[1].email = ' Mixed@Example.Test ';
    f.tables.marketing_suppressions = [{ email: '  MIXED@example.test  ' }];
    await sendPushCampaignAction('campaign');
    expect(state.send.mock.calls.map(c => c[1])).toEqual([userId(0), userId(0), userId(2)]);
    expect(campaign(f)).toMatchObject({ recipients: 2, sent: 3 });
  });

  it.each(['push_devices', 'profiles', 'marketing_suppressions'])('fails closed on a returned later %s page error, then recovers', async table => {
    const f = fixture(3, 2);
    f.tables.marketing_suppressions = [{ email: 'a@example.test' }, { email: 'b@example.test' }, { email: `${userId(2)}@example.test` }];
    f.faults.add(`${table}:select:2`);
    await failsBeforeSending(f);
    f.faults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send.mock.calls.map(c => c[1])).toEqual([userId(0), userId(1)]);
    expect(campaign(f)).toMatchObject({ status: 'sent', recipients: 2, sent: 2 });
  });

  it.each(['push_devices', 'profiles', 'marketing_suppressions'])('fails closed on a thrown later %s page error, then recovers', async table => {
    const f = fixture(3, 2);
    f.tables.marketing_suppressions = [{ email: 'a@example.test' }, { email: 'b@example.test' }, { email: `${userId(2)}@example.test` }];
    f.thrownFaults.add(`${table}:select:2`);
    await failsBeforeSending(f);
    f.thrownFaults.clear();
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing profile after successful reads instead of treating an unknown email as eligible', async () => {
    const f = fixture(201);
    f.tables.profiles.pop();
    await failsBeforeSending(f);
    f.tables.profiles.push({ id: userId(200), email: `${userId(200)}@example.test` });
    f.tables.marketing_suppressions.push({ email: `${userId(200)}@example.test` });
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(200);
  });

  it.each([undefined, '', '   ', 123, 'not-an-email', 'double@@example.test', 'name@localhost'])('rejects incomplete or malformed profile email %s before delivery', async email => {
    const f = fixture(); f.tables.profiles[0].email = email;
    await failsBeforeSending(f);
  });

  it('preserves a verified explicit null email for a phone-only account', async () => {
    const f = fixture(); f.tables.profiles[0].email = null;
    await sendPushCampaignAction('campaign');
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(campaign(f)).toMatchObject({ recipients: 1, sent: 1 });
  });

  it.each(['push_devices', 'profiles', 'marketing_suppressions'])('rejects invalid %s pagination keys before sending', async table => {
    const f = fixture();
    if (table === 'marketing_suppressions') f.tables[table] = [{ email: '' }];
    else f.tables[table][0].id = '';
    await failsBeforeSending(f);
  });

  it('rejects repeated keys rather than looping or silently accepting incomplete data', async () => {
    const f = fixture(); f.tables.push_devices.push({ ...f.tables.push_devices[0] });
    await failsBeforeSending(f);
  });

  it.each(['repeated-page', 'missing-data'])('rejects a malformed %s suppression response before delivery', async mode => {
    const f = fixture();
    let reads = 0;
    // Only this deliberately malformed transport response bypasses the stateful
    // fixture; all other reads, campaign reservations and failed writes execute.
    const from = f.db.from as unknown as (table: string) => unknown;
    state.db = { from(table: string) {
      if (table !== 'marketing_suppressions') return from(table);
      const query = {
        select: () => query, order: () => query, limit: () => query, gt: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          reads++;
          return Promise.resolve({ data: mode === 'missing-data' ? null : [{ email: 'fixture@example.test' }], error: null }).then(resolve);
        },
      };
      return query;
    } };
    await failsBeforeSending(f);
    expect(reads).toBe(mode === 'missing-data' ? 1 : 2);
    expect(state.failure.mock.calls.at(-1)?.[1].message).toMatch(mode === 'missing-data' ? /completely load/ : /repeated/);
  });

  it('fails explicitly before sending when the global row budget is exceeded', async () => {
    const f = fixture();
    f.tables.marketing_suppressions = Array.from({ length: 50_001 }, (_, i) => ({ email: `a${String(i).padStart(5, '0')}@example.test` }));
    await failsBeforeSending(f);
    expect(f.calls.filter(c => c.table === 'marketing_suppressions')).toHaveLength(250);
    expect(state.failure.mock.calls.at(-1)?.[1].message).toContain('50,000-row read limit');
  });

  it('fails explicitly when a tiny response cap exhausts the global request budget', async () => {
    const f = fixture(1, 1);
    f.tables.marketing_suppressions = Array.from({ length: 1001 }, (_, i) => ({ email: `a${String(i).padStart(4, '0')}@example.test` }));
    await failsBeforeSending(f);
    expect(f.calls.filter(c => ['push_devices', 'profiles', 'marketing_suppressions'].includes(c.table))).toHaveLength(1000);
    expect(state.failure.mock.calls.at(-1)?.[1].message).toContain('1,000-request read limit');
  });

  it('completes a verified empty device audience without unrelated reads', async () => {
    const f = fixture(0);
    f.faults.add('profiles:select'); f.faults.add('marketing_suppressions:select');
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(campaign(f)).toMatchObject({ status: 'sent', recipients: 0, sent: 0 });
    expect(f.calls.some(c => c.table === 'profiles' || c.table === 'marketing_suppressions')).toBe(false);
  });

  it('allows only the reserved campaign worker to finish its audience and send', async () => {
    const f = fixture(3, 2);
    await Promise.all([sendPushCampaignAction('campaign'), sendPushCampaignAction('campaign')]);
    expect(state.send).toHaveBeenCalledTimes(3);
    expect(state.audit).toHaveBeenCalledTimes(1);
    expect(campaign(f)).toMatchObject({ status: 'sent', recipients: 3, sent: 3 });
  });

  it('retains consent opt-outs after complete audience loading', async () => {
    const f = fixture(2);
    f.tables.user_preferences = [{ user_id: userId(0), push_enabled: false }];
    f.tables.family_members = [{ user_id: userId(1), family_id: 'family', role: 'child', is_active: true }];
    f.tables.family_ai_settings = [{ family_id: 'family', child_channels: { push: false } }];
    await sendPushCampaignAction('campaign');
    expect(state.send).not.toHaveBeenCalled();
    expect(campaign(f)).toMatchObject({ recipients: 2, sent: 0, skipped: 2 });
    expect(state.audit.mock.calls[0][1].metadata).toMatchObject({ withheld: 2, deviceSkipped: 0 });
  });
});
