import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewConfirmationImport, applyConfirmationImport } from '@/lib/services/trips/confirmation-import';
import { travelImportTools } from '@/lib/ai/tools/travel-import';
import type { ServiceScope } from '@/lib/services/types';
import type { ConfirmationPreview, ConfirmationResult } from '@/lib/vacations/confirmation-import';

const forbidden = vi.hoisted(() => ({
  admin: vi.fn(() => { throw new Error('No admin client'); }),
  provider: vi.fn(() => { throw new Error('No provider calls'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: forbidden.admin }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: forbidden.provider }));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const TRIP = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const RESERVATION = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';

function fixture() {
  const source = { title: 'Dinner confirmation', text: 'Name: Dinner\r\nWhen: 2026-09-10T18:30:45.999-04:00\nCode: ABC123\n' };
  const fields = {
    name: 'Dinner', kind: 'dining', location: 'Harbor', reservedAt: '2026-09-10T18:30:45.999-04:00',
    partySize: 4, confirmationCode: 'ABC123', booked: true,
  };
  const preview: ConfirmationPreview = {
    version: 1, familyId: FAMILY, memberId: MEMBER, vacationId: TRIP,
    trip: {
      id: TRIP, title: 'Family trip', startDate: '2026-09-09', endDate: '2026-09-12',
      timezone: 'America/New_York', status: 'planning', updatedAt: '2026-09-06T12:00:00.123456+00:00',
    },
    source: { ...source, sha256: createHash('sha256').update(source.text, 'utf8').digest('hex') },
    fields, itinerary: { date: '2026-09-10', startTime: '18:30:45', dayPart: 'evening' },
  };
  const result: ConfirmationResult = {
    preview, applied: false, requestId: null, appliedAt: null, reservationId: null, itineraryItemId: null,
  };
  return { input: { vacationId: TRIP, source, fields }, preview, result };
}

type Reply = { data: unknown; error: { code: string; message?: string } | null };
function harness() {
  const f = fixture();
  const state = {
    responses: {
      family_members: { data: { id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true }, error: null },
      user_preferences: { data: { active_family_id: FAMILY }, error: null },
      families: { data: { id: FAMILY, trial_ends_at: null, closed_at: null }, error: null },
      subscriptions: { data: [{ family_id: FAMILY, plan: 'basic', status: 'active' }], error: null },
      app_settings: { data: { value: {} }, error: null },
    } as Record<string, Reply>,
    rpcReply: { data: f.result, error: null } as Reply,
  };
  const mutation = vi.fn(() => { throw new Error('Direct table mutation is forbidden'); });
  const queries: { table: string; filters: [string, unknown][] }[] = [];
  const from = vi.fn((table: string) => {
    if (!(table in state.responses)) throw new Error('Unexpected table access: ' + table);
    const record = { table, filters: [] as [string, unknown][] };
    queries.push(record);
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => { record.filters.push([column, value]); return query; }),
      in: vi.fn((column: string, value: unknown) => { record.filters.push([column, value]); return query; }),
      maybeSingle: vi.fn(async () => state.responses[table]),
      then: (resolve: (reply: Reply) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(state.responses[table]).then(resolve, reject),
      insert: mutation, update: mutation, delete: mutation, upsert: mutation,
    };
    return query;
  });
  const getUser = vi.fn(async () => ({ data: { user: { id: USER } }, error: null }));
  const rpc = vi.fn(async () => state.rpcReply);
  const db = { from, rpc, auth: { getUser } };
  const scope: ServiceScope = {
    db: db as unknown as ServiceScope['db'],
    familyId: FAMILY, memberId: MEMBER, userId: USER, role: 'parent', actorKind: 'member', tz: 'UTC',
  };
  return { ...f, state, scope, db, rpc, getUser, from, queries, mutation };
}

function saved(preview: ConfirmationPreview): ConfirmationResult {
  return {
    preview, applied: true, requestId: REQUEST, appliedAt: '2026-09-06T12:01:02.123456+00:00',
    reservationId: RESERVATION, itineraryItemId: ITEM,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network/provider access is forbidden'); }));
});
afterEach(() => {
  expect(forbidden.admin).not.toHaveBeenCalled();
  expect(forbidden.provider).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('reviewed confirmation service', () => {
  it('uses only a read-only preview RPC, preserving exact source bytes, offset and truncated wallclock', async () => {
    const h = harness();
    const result = await previewConfirmationImport(h.scope, h.input);
    expect(result).toEqual({ ok: true, data: h.result });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('vacation_import_confirmation', {
      p_family_id: FAMILY, p_vacation_id: TRIP, p_member_id: MEMBER,
      p_source: h.input.source, p_fields: h.input.fields, p_expected: null, p_request_id: null,
    });
    expect(h.queries.find((query) => query.table === 'family_members')?.filters).toEqual([
      ['id', MEMBER], ['family_id', FAMILY], ['user_id', USER], ['is_active', true],
    ]);
    expect(h.queries.find((query) => query.table === 'user_preferences')?.filters).toEqual([['user_id', USER]]);
    expect(h.queries.find((query) => query.table === 'subscriptions')?.filters).toEqual([
      ['family_id', FAMILY], ['status', ['active', 'trialing']],
    ]);
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it('normalizes user fields and title but never normalizes the source text', async () => {
    const h = harness();
    const input = { ...h.input, source: { ...h.input.source, title: '  Dinner confirmation  ' }, fields: { ...h.input.fields, name: ' Dinner ' } };
    expect((await previewConfirmationImport(h.scope, input)).ok).toBe(true);
    expect(h.rpc.mock.calls[0]?.[1]).toMatchObject({ p_source: h.input.source, p_fields: h.input.fields });
  });

  it.each(['child', 'teen', 'system'] as const)('denies the %s scope role without an RPC', async (role) => {
    const h = harness();
    h.scope.role = role as ServiceScope['role'];
    expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'denied' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(['ai', 'system'] as const)('refuses apply for actorKind %s', async (actorKind) => {
    const h = harness();
    h.scope.actorKind = actorKind;
    expect(await applyConfirmationImport(h.scope, { ...h.input, expected: h.preview, requestId: REQUEST }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('accepts the exact active adult membership', async () => {
    const h = harness();
    h.scope.role = 'adult';
    h.state.responses.family_members.data = { id: MEMBER, family_id: FAMILY, user_id: USER, role: 'adult', is_active: true };
    expect((await previewConfirmationImport(h.scope, h.input)).ok).toBe(true);
  });

  const deniedContexts: [string, (h: ReturnType<typeof harness>) => void][] = [
    ['different authenticated user', (h) => { h.getUser.mockResolvedValue({ data: { user: { id: OTHER } }, error: null }); }],
    ['missing member', (h) => { h.state.responses.family_members.data = null; }],
    ['inactive member', (h) => { h.state.responses.family_members.data = { id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: false }; }],
    ['role changed', (h) => { h.state.responses.family_members.data = { id: MEMBER, family_id: FAMILY, user_id: USER, role: 'adult', is_active: true }; }],
    ['different family membership', (h) => { h.state.responses.family_members.data = { id: MEMBER, family_id: OTHER, user_id: USER, role: 'parent', is_active: true }; }],
    ['different member identity', (h) => { h.state.responses.family_members.data = { id: OTHER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true }; }],
    ['active family changed', (h) => { h.state.responses.user_preferences.data = { active_family_id: OTHER }; }],
    ['missing active preference', (h) => { h.state.responses.user_preferences.data = null; }],
    ['feature switched off', (h) => { h.state.responses.app_settings.data = { value: { trips: 'off' } }; }],
    ['plan downgraded', (h) => { h.state.responses.subscriptions.data = []; }],
    ['family closed', (h) => { h.state.responses.families.data = { id: FAMILY, trial_ends_at: null, closed_at: '2026-09-06T12:00:00Z' }; }],
    ['expired free trial', (h) => {
      h.state.responses.subscriptions.data = [];
      h.state.responses.families.data = { id: FAMILY, trial_ends_at: '2000-01-01T00:00:00Z', closed_at: null };
    }],
  ];
  it.each(deniedContexts)('rechecks %s before an apply or receipt retry', async (_name, change) => {
    const h = harness();
    expect((await previewConfirmationImport(h.scope, h.input)).ok).toBe(true);
    h.rpc.mockClear();
    change(h);
    h.state.rpcReply.data = saved(h.preview);
    expect(await applyConfirmationImport(h.scope, { ...h.input, expected: h.preview, requestId: REQUEST }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it.each(['family_members', 'user_preferences', 'families', 'subscriptions', 'app_settings'])(
    'fails closed when %s cannot be read', async (table) => {
      const h = harness();
      h.state.responses[table] = { data: null, error: { code: '42P01', message: h.input.source.text } };
      expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'db' });
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(['families', 'subscriptions', 'app_settings'])('rejects missing or malformed %s state', async (table) => {
    const h = harness();
    h.state.responses[table].data = null;
    expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'db' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed feature settings instead of falling back to a permissive tier', async () => {
    const h = harness();
    h.state.responses.app_settings.data = { value: { trips: 'unexpected' } };
    expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'db' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['22023', 'invalid_input'], ['55000', 'conflict'], ['40001', 'conflict'],
    ['23505', 'conflict'], ['42501', 'denied'], ['P0002', 'not_found'],
    ['PGRST202', 'db'], ['42883', 'db'], ['42P01', 'db'], ['42703', 'db'],
  ])('maps SQLSTATE %s without exposing the RPC error', async (sqlstate, code) => {
    const h = harness();
    h.state.rpcReply = { data: null, error: { code: sqlstate, message: h.input.source.text } };
    const result = await previewConfirmationImport(h.scope, h.input);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(h.input.source.text);
  });

  const corruptions: [string, (receipt: ConfirmationResult) => unknown][] = [
    ['null result', () => null],
    ['array result', (r) => [r]],
    ['unknown result key', (r) => ({ ...r, providerVerified: true })],
    ['different family', (r) => { r.preview.familyId = OTHER; return r; }],
    ['different member', (r) => { r.preview.memberId = OTHER; return r; }],
    ['different vacation', (r) => { r.preview.vacationId = OTHER; return r; }],
    ['different trip', (r) => { r.preview.trip.id = OTHER; return r; }],
    ['different source title', (r) => { r.preview.source.title = 'Other'; return r; }],
    ['different source text', (r) => { r.preview.source.text += ' '; return r; }],
    ['wrong source hash', (r) => { r.preview.source.sha256 = '0'.repeat(64); return r; }],
    ['different fields', (r) => { r.preview.fields.booked = false; return r; }],
    ['rounded second', (r) => { r.preview.itinerary.startTime = '18:30:46'; return r; }],
    ['wrong local day', (r) => { r.preview.itinerary.date = '2026-09-11'; return r; }],
    ['wrong day part', (r) => { r.preview.itinerary.dayPart = 'morning'; return r; }],
    ['invalid timezone', (r) => { r.preview.trip.timezone = 'not/a-zone'; return r; }],
    ['impossible date', (r) => { r.preview.trip.startDate = '2026-02-30'; return r; }],
    ['outside trip dates', (r) => { r.preview.trip.endDate = '2026-09-09'; return r; }],
    ['receipt disguised as preview', (r) => saved(r.preview)],
    ['preview with saved identifier', (r) => { r.reservationId = RESERVATION; return r; }],
  ];
  it.each(corruptions)('rejects a malformed/mismatched RPC response: %s', async (_name, corrupt) => {
    const h = harness();
    h.state.rpcReply.data = corrupt(structuredClone(h.result));
    expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'db' });
  });

  it('requires the complete exact approved preview in an apply receipt', async () => {
    const h = harness();
    const changed = structuredClone(h.preview);
    changed.trip.title = 'Changed after review';
    h.state.rpcReply.data = saved(changed);
    expect(await applyConfirmationImport(h.scope, { ...h.input, expected: h.preview, requestId: REQUEST }))
      .toMatchObject({ ok: false, code: 'db' });
  });

  it.each(['requestId', 'reservationId', 'itineraryItemId', 'appliedAt'] as const)(
    'rejects an invalid saved receipt %s', async (key) => {
      const h = harness();
      h.state.rpcReply.data = { ...saved(h.preview), [key]: key === 'requestId' ? OTHER : null };
      expect(await applyConfirmationImport(h.scope, { ...h.input, expected: h.preview, requestId: REQUEST }))
        .toMatchObject({ ok: false, code: 'db' });
    },
  );

  it('rejects mismatched approval input before any RPC', async () => {
    const h = harness();
    const expected = structuredClone(h.preview);
    expected.source.sha256 = 'f'.repeat(64);
    expect(await applyConfirmationImport(h.scope, { ...h.input, expected, requestId: REQUEST }))
      .toMatchObject({ ok: false, code: 'invalid_input' });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(['0001-01-01T00:00:00+14:00', '9999-12-31T23:59:59-14:00'])(
    'rejects an instant outside supported UTC years: %s', async (reservedAt) => {
      const h = harness();
      expect(await previewConfirmationImport(h.scope, { ...h.input, fields: { ...h.input.fields, reservedAt } }))
        .toMatchObject({ ok: false, code: 'invalid_input' });
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it('rejects a local day outside supported years even when the UTC instant is supported', async () => {
    const h = harness();
    h.input.fields.reservedAt = '0001-01-01T00:00:00Z';
    h.preview.trip.startDate = '0001-01-01';
    h.preview.trip.endDate = '0001-01-02';
    h.preview.trip.timezone = 'Etc/GMT+12';
    h.preview.itinerary = { date: '0001-01-01', startTime: '12:00:00', dayPart: 'afternoon' };
    expect(await previewConfirmationImport(h.scope, h.input)).toMatchObject({ ok: false, code: 'db' });
  });

  it('returns the original receipt after a lost response without taking a new trip preview', async () => {
    const h = harness();
    const receipt = saved(h.preview);
    let calls = 0;
    h.rpc.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Response lost after transaction commit');
      return { data: structuredClone(receipt), error: null };
    });
    const approved = { ...h.input, expected: structuredClone(h.preview), requestId: REQUEST };
    expect(await applyConfirmationImport(h.scope, approved)).toMatchObject({ ok: false, code: 'db', retryable: true });
    expect(await applyConfirmationImport(h.scope, approved)).toEqual({ ok: true, data: receipt });
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    expect(h.queries.some((query) => query.table === 'vacations')).toBe(false);
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it('keeps travel.import explicitly preview-only and links to manual review', async () => {
    const h = harness();
    h.scope.actorKind = 'ai';
    const tool = travelImportTools[0];
    expect(tool).toMatchObject({ name: 'travel.import', domain: 'travel', capability: 'view', risk: 'low', readOnly: true });
    expect(tool.input.safeParse({ ...h.input, action: 'apply', expected: h.preview, requestId: REQUEST }).success).toBe(false);
    const input = tool.input.parse(h.input);
    const result = await tool.execute(h.scope, input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected preview');
    const output = tool.output.parse(result.data);
    expect(output).toMatchObject({ result: { applied: false }, reviewUrl: '/dashboard/vacations/' + TRIP + '/ai-assistant' });
    expect(tool.summarize(input, output)).toContain('unsaved');
    expect(tool.summarize(input, output)).toContain('Review and save manually');
    expect(tool.summarize(input, output)).toContain('No booking, availability, or price verification');
    expect(h.rpc.mock.calls[0]?.[1]).toMatchObject({ p_expected: null, p_request_id: null });
    expect(h.mutation).not.toHaveBeenCalled();
  });
});
