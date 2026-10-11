import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { dispatchPendingPushes, sendPushToUser } from '@/lib/server/push';
import type { Database } from '@/lib/database.types';

// Actual dispatcher + installed PostgREST client. Only finite REST replies and
// device providers are synthetic; this does not assert SQL/RLS or atomic send
// authorization after the final membership read.
const transport = vi.hoisted(() => ({ native: vi.fn(), web: vi.fn(), endpoint: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({
  sendNativePush: transport.native,
  nativePushConfigured: () => ({ fcm: true, apns: true }),
}));
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: transport.web },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: transport.endpoint }));

const NOW = new Date('2026-10-09T18:00:00Z');
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherFamily = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = '11111111-1111-4111-8111-111111111111';
const otherUser = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Row = Record<string, unknown>;
const notice = (n = 1, extra: Row = {}): Row => ({
  id: id(n),
  family_id: family,
  user_id: user,
  title: 'Synthetic family reminder',
  body: 'Synthetic family-only content',
  related_type: null,
  related_id: null,
  created_at: NOW.toISOString(),
  send_at: NOW.toISOString(),
  pushed_at: null,
  ...extra,
});
const member = (extra: Row = {}): Row => ({
  id: id(10),
  user_id: user,
  family_id: family,
  role: 'parent',
  is_active: true,
  ...extra,
});
const device = (n = 1, extra: Row = {}): Row => ({
  id: id(100 + n),
  user_id: user,
  provider: 'fcm',
  platform: 'android',
  enabled: true,
  token: `synthetic-token-${n}`,
  ...extra,
});

function fixture(
  options: {
    members?: Row[];
    notices?: Row[];
    devices?: Row[];
    onDevices?: () => void;
    lateReply?: unknown;
    lateStatus?: number;
    lateThrow?: boolean;
    delivered?: Row[];
    finalFamilies?: string[];
  } = {},
) {
  const tables: Record<string, Row[]> = {
    family_members: options.members ?? [member()],
    notifications: options.notices ?? [notice()],
    push_devices: options.devices ?? [device()],
    family_ai_settings: [],
    user_preferences: [],
    push_deliveries: options.delivered ?? [],
    app_settings: [],
  };
  const calls: { table: string; method: string; query: Record<string, string> }[] = [];
  const transportErrors: string[] = [];
  let touchedDevices = false;
  const reply = (data: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const matches = (row: Row, key: string, expression: string) => {
    if (expression === 'is.null') return row[key] == null;
    if (expression.startsWith('eq.')) return String(row[key]) === expression.slice(3);
    if (expression.startsWith('lte.')) return String(row[key]) <= expression.slice(4);
    if (expression.startsWith('in.('))
      return expression
        .slice(4, -1)
        .split(',')
        .map((s) => s.replace(/^"|"$/g, ''))
        .includes(String(row[key]));
    throw new Error(`Unsupported synthetic filter ${key}:${expression}`);
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const req = new Request(input, init),
        url = new URL(req.url),
        table = url.pathname.slice('/rest/v1/'.length);
      if (
        url.origin !== 'https://push-race-fixture.invalid' ||
        !url.pathname.startsWith('/rest/v1/') ||
        !(table in tables)
      )
        throw new Error('Unexpected synthetic SDK destination');
      calls.push({ table, method: req.method, query: Object.fromEntries(url.searchParams) });
      if (table === 'push_devices' && req.method === 'GET' && !touchedDevices) {
        touchedDevices = true;
        options.onDevices?.();
      }
      const late =
        table === 'family_members' &&
        req.method === 'GET' &&
        url.searchParams.has('user_id') &&
        url.searchParams.get('user_id')?.startsWith('eq.');
      if (late) {
        expect((options.finalFamilies ?? [family]).map((value) => 'eq.' + value)).toContain(
          url.searchParams.get('family_id'),
        );
        expect(url.searchParams.get('is_active')).toBe('eq.true');
        expect(url.searchParams.get('select')).toBe('user_id,family_id,is_active');
        expect(url.searchParams.get('limit')).toBe('1');
        if (options.lateThrow) throw new Error('Synthetic final membership transport failure');
        if ('lateReply' in options) return reply(options.lateReply, options.lateStatus ?? 200);
      }
      if (req.method === 'POST') {
        const patch = (await req.json()) as Row;
        if (table === 'app_settings') {
          tables[table] = [{ ...patch }];
          return reply([{ key: patch.key }], 201);
        }
        if (table === 'push_deliveries') {
          tables[table].push(patch);
          return reply(null, 204);
        }
        throw new Error('Unexpected synthetic POST');
      }
      let rows = tables[table].filter((row) =>
        [...url.searchParams].every(
          ([key, expr]) =>
            ['select', 'order', 'limit', 'offset', 'on_conflict', 'or'].includes(key) ||
            matches(row, key, expr),
        ),
      );
      if (url.searchParams.has('or') && table === 'notifications')
        rows = rows.filter((row) => row.related_type !== 'family_message');
      if (req.method === 'PATCH' && table === 'notifications') {
        const patch = (await req.json()) as Row;
        for (const row of rows) Object.assign(row, patch);
        return reply(null, 204);
      }
      if (req.method !== 'GET') throw new Error('Unexpected synthetic method');
      const offset = Number(url.searchParams.get('offset') ?? 0),
        limit = Number(url.searchParams.get('limit') ?? 1000);
      rows = rows.slice(offset, offset + limit);
      const select = url.searchParams.get('select');
      if (select && select !== '*')
        rows = rows.map((row) =>
          Object.fromEntries(select.split(',').map((key) => [key, row[key]])),
        );
      return reply(rows);
    } catch (error) {
      // A deliberately thrown final transport read exercises the real SDK's
      // retry/error path; all other exceptions must be visible test failures.
      if (!(
        options.lateThrow &&
        error instanceof Error &&
        error.message === 'Synthetic final membership transport failure'
      ))
        transportErrors.push(String(error));
      throw error;
    }
  };
  const db = createClient<Database>('https://push-race-fixture.invalid', 'synthetic-public-key', {
    accessToken: async () => null,
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    db,
    tables,
    calls,
    transportErrors,
    rechecks: () =>
      calls.filter((c) => c.table === 'family_members' && c.query.user_id?.startsWith('eq.')),
  };
}

beforeEach(() => {
  transport.native.mockReset().mockResolvedValue('sent');
  transport.web.mockReset().mockResolvedValue(undefined);
  transport.endpoint.mockReset().mockResolvedValue(true);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'synthetic-vapid-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'synthetic-vapid-private');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function safe(f: ReturnType<typeof fixture>) {
  expect(f.transportErrors).toEqual([]);
}
async function withheld(f: ReturnType<typeof fixture>) {
  const result = await dispatchPendingPushes(f.db, { now: NOW });
  expect(result.result).toEqual({ sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 1 });
  expect(transport.native).not.toHaveBeenCalled();
  expect(transport.web).not.toHaveBeenCalled();
  expect(f.tables.push_deliveries).toEqual([]);
  expect(f.tables.notifications[0].pushed_at).not.toBeNull();
  safe(f);
}

describe('queued family push final membership checks', () => {
  for (const broadcast of [false, true])
    it(`withholds ${broadcast ? 'broadcast' : 'direct'} delivery after membership is revoked during device lookup`, async () => {
      let f: ReturnType<typeof fixture>;
      f = fixture({
        notices: [notice(1, { user_id: broadcast ? null : user })],
        onDevices: () => {
          f.tables.family_members[0].is_active = false;
        },
      });
      await withheld(f);
      expect(f.rechecks()).toHaveLength(1);
    });
  it('a membership moved to another family during device lookup does not authorize the old family payload', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({
      onDevices: () => {
        f.tables.family_members[0].family_id = otherFamily;
      },
    });
    await withheld(f);
  });
  it('a deleted membership during device lookup cannot receive the queued payload', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({
      onDevices: () => {
        f.tables.family_members = [];
      },
    });
    await withheld(f);
  });
  it('a membership revoked during web endpoint validation is checked after that asynchronous boundary', async () => {
    const f = fixture({
      devices: [
        device(1, {
          provider: 'webpush',
          endpoint: 'https://push-provider-fixture.invalid/subscription',
          p256dh: 'synthetic-key',
          auth: 'synthetic-auth',
        }),
      ],
    });
    transport.endpoint.mockImplementation(async () => {
      f.tables.family_members[0].is_active = false;
      return true;
    });
    await withheld(f);
    expect(transport.endpoint).toHaveBeenCalledTimes(1);
  });
  it('rechecks between devices while retaining the receipt for an already accepted send', async () => {
    const f = fixture({ devices: [device(1), device(2)] });
    transport.native.mockImplementation(async () => {
      f.tables.family_members[0].is_active = false;
      return 'sent';
    });
    const result = await dispatchPendingPushes(f.db, { now: NOW });
    expect(result.result).toEqual({ sent: 1, skipped: 0, failed: 0, pruned: 0, withheld: 1 });
    expect(transport.native).toHaveBeenCalledTimes(1);
    expect(f.tables.push_deliveries).toEqual([{ notification_id: id(1), device_id: id(101) }]);
    expect(f.rechecks()).toHaveLength(2);
    expect(f.tables.notifications[0].pushed_at).not.toBeNull();
    safe(f);
  });
  for (const role of ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])
    it(`preserves healthy ${role} delivery with exact current-family query bounds`, async () => {
      const f = fixture({ members: [member({ role })] });
      const result = await dispatchPendingPushes(f.db, { now: NOW });
      expect(result.result).toEqual({ sent: 1, skipped: 0, failed: 0, pruned: 0, withheld: 0 });
      expect(transport.native).toHaveBeenCalledTimes(1);
      expect(f.rechecks()).toHaveLength(1);
      safe(f);
    });
  it('does not add family authorization to a general own-device test sender', async () => {
    const f = fixture({ members: [] });
    expect((await sendPushToUser(f.db, user, { title: 'Synthetic own-device test' })).sent).toBe(1);
    expect(f.rechecks()).toEqual([]);
    safe(f);
  });
  it('does not recheck or resend an already recorded device', async () => {
    const f = fixture({ delivered: [{ notification_id: id(1), device_id: id(101) }] });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(0);
    expect(transport.native).not.toHaveBeenCalled();
    expect(f.rechecks()).toEqual([]);
    safe(f);
  });
  for (const provider of ['fcm', 'apns'])
    it(`preserves ${provider} failures as pending instead of deliberate withholding`, async () => {
      const f = fixture({ devices: [device(1, { provider })] });
      transport.native.mockResolvedValue('failed');
      expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({
        sent: 0,
        skipped: 0,
        failed: 1,
        pruned: 0,
        withheld: 0,
      });
      expect(f.tables.notifications[0].pushed_at).toBeNull();
      expect(f.tables.push_deliveries).toEqual([]);
      safe(f);
    });
  const invalid: [string, unknown][] = [
    ['null', null],
    ['object instead of rows', { user_id: user, family_id: family, is_active: true }],
    ['string', 'synthetic'],
    ['number', 1],
    ['boolean', true],
    ['missing user', [{ family_id: family, is_active: true }]],
    ['missing family', [{ user_id: user, is_active: true }]],
    ['missing active', [{ user_id: user, family_id: family }]],
    ['foreign user', [{ user_id: otherUser, family_id: family, is_active: true }]],
    ['foreign family', [{ user_id: user, family_id: otherFamily, is_active: true }]],
    ['inactive response', [{ user_id: user, family_id: family, is_active: false }]],
    ['numeric active', [{ user_id: user, family_id: family, is_active: 1 }]],
    ['multiple rows', [member(), member()]],
  ];
  for (const [label, lateReply] of invalid)
    it(`fails closed and keeps the queue pending for malformed final lookup: ${label}`, async () => {
      const f = fixture({ lateReply });
      const result = await dispatchPendingPushes(f.db, { now: NOW });
      expect(result.result).toEqual({ sent: 0, skipped: 0, failed: 1, pruned: 0, withheld: 0 });
      expect(transport.native).not.toHaveBeenCalled();
      expect(transport.web).not.toHaveBeenCalled();
      expect(f.tables.push_deliveries).toEqual([]);
      expect(f.tables.notifications[0].pushed_at).toBeNull();
      safe(f);
    });
  it('keeps a refused final membership read pending without any provider call', async () => {
    const f = fixture({
      lateReply: { code: '42501', message: 'Synthetic membership refusal' },
      lateStatus: 403,
    });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(1);
    expect(transport.native).not.toHaveBeenCalled();
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    safe(f);
  });
  it('does not expire an old notification after an unreadable final membership check', async () => {
    const f = fixture({
      notices: [
        notice(1, { created_at: new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString() }),
      ],
      lateReply: { code: '42501', message: 'Synthetic membership refusal' },
      lateStatus: 403,
    });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(1);
    expect(transport.native).not.toHaveBeenCalled();
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    safe(f);
  });
  it('binds final checks to each queued family in a global batch', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({
      members: [member(), member({ id: id(11), family_id: otherFamily })],
      notices: [notice(1), notice(2, { family_id: otherFamily })],
      finalFamilies: [family, otherFamily],
      onDevices: () => {
        f.tables.family_members[0].is_active = false;
      },
    });
    const result = await dispatchPendingPushes(f.db, { now: NOW });
    expect(result.result).toEqual({ sent: 1, skipped: 0, failed: 0, pruned: 0, withheld: 1 });
    expect(f.rechecks().map((call) => call.query.family_id)).toEqual([
      'eq.' + family,
      'eq.' + otherFamily,
    ]);
    expect(f.tables.push_deliveries).toEqual([{ notification_id: id(2), device_id: id(101) }]);
    safe(f);
  });
  it('keeps an exhausted final membership transport read pending without any provider call', async () => {
    const f = fixture({ lateThrow: true });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(1);
    expect(transport.native).not.toHaveBeenCalled();
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    safe(f);
  });
});
