import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as route from '@/app/api/moving/recalculate/route';
import { isMoveDatePreview, isMoveDateResult, type MoveDatePreview, type MoveDateResult } from '@/lib/moving/recalculation';

const mocks = vi.hoisted(() => ({ context: vi.fn(), createServer: vi.fn(), superAdmin: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.context, isSuperAdmin: mocks.superAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.plan }));

const FAMILY = '10000000-0000-4000-8000-000000000001';
const MEMBER = '10000000-0000-4000-8000-000000000002';
const MOVE = '10000000-0000-4000-8000-000000000003';
const REQUEST = '10000000-0000-4000-8000-000000000004';
const OTHER = '10000000-0000-4000-8000-000000000009';
const STAMP = '2026-09-06T12:00:00.000Z';
const APPLIED_AT = '2026-09-06T12:05:00.000Z';
const DATE = '2026-09-30';
const LIMIT = 1024 * 1024;
const PRIVATE_DETAIL = 'private database detail must never leave the server';
const URL = 'http://localhost/api/moving/recalculate';

function preview(overrides: Partial<MoveDatePreview> = {}): MoveDatePreview {
  return {
    version: 1, familyId: FAMILY, memberId: MEMBER, moveId: MOVE,
    fromDate: '2026-09-20', toDate: DATE, moveUpdatedAt: STAMP,
    tasks: [
      { id: '10000000-0000-4000-8000-000000000005', title: 'Reserve packing supplies', status: 'todo', mode: 'relative', offsetDays: -7, dueDate: '2026-09-13', nextDueDate: '2026-09-23', updatedAt: STAMP, action: 'shift', reason: 'relative' },
      { id: '10000000-0000-4000-8000-000000000006', title: 'Utility appointment', status: 'doing', mode: 'fixed', offsetDays: 0, dueDate: '2026-09-19', nextDueDate: '2026-09-19', updatedAt: STAMP, action: 'preserve', reason: 'fixed' },
      { id: '10000000-0000-4000-8000-000000000007', title: 'Completed preparation', status: 'done', mode: 'relative', offsetDays: -2, dueDate: '2026-09-18', nextDueDate: '2026-09-18', updatedAt: STAMP, action: 'preserve', reason: 'completed' },
      { id: '10000000-0000-4000-8000-000000000008', title: 'Skipped preparation', status: 'skipped', mode: 'relative', offsetDays: -1, dueDate: '2026-09-19', nextDueDate: '2026-09-19', updatedAt: STAMP, action: 'preserve', reason: 'skipped' },
    ],
    changes: 1,
    ...overrides,
  };
}

function result(applied = false, reviewed = preview()): MoveDateResult {
  return { preview: reviewed, applied, requestId: applied ? REQUEST : null, appliedAt: applied ? APPLIED_AT : null };
}

const contextFor = (role = 'parent') => ({
  user: { id: OTHER },
  active: { familyId: FAMILY, role, member: { id: MEMBER, is_active: true } },
});
const bodyFor = (overrides: Record<string, unknown> = {}) => ({ familyId: FAMILY, memberId: MEMBER, moveId: MOVE, date: DATE, ...overrides });
const request = (body: unknown = bodyFor()) => new Request(URL, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const applyBody = (expected: unknown = preview(), requestId: unknown = REQUEST) => bodyFor({ expected, requestId });

let setting: { data: unknown; error: unknown };
let query: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> };
let from: ReturnType<typeof vi.fn>;
let rpc: ReturnType<typeof vi.fn>;
let db: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mocks.context.mockReset().mockResolvedValue(contextFor());
  mocks.superAdmin.mockReset().mockResolvedValue(false);
  mocks.plan.mockReset().mockResolvedValue(1);
  setting = { data: { value: {} }, error: null };
  query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => setting),
  };
  from = vi.fn((table: string) => {
    if (table !== 'app_settings') throw new Error('Unexpected direct table access');
    return query;
  });
  rpc = vi.fn().mockResolvedValue({ data: result(), error: null });
  db = { from, rpc };
  mocks.createServer.mockReset().mockResolvedValue(db);
});

afterEach(() => {
  for (const [table] of from.mock.calls) expect(table).toBe('app_settings');
  for (const [name] of rpc.mock.calls) expect(name).toBe('move_recalculate_date');
});

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['code', 'error']);
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe('string');
  expect(JSON.stringify(body)).not.toContain(PRIVATE_DETAIL);
  return body;
}

function streamRequest(text: string, declaredLength?: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 65536));
      offset += 65536;
    },
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (declaredLength !== undefined) headers['Content-Length'] = declaredLength;
  return new Request(URL, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
}

describe('move-date recalculation API', () => {
  it('exports POST only and refuses other methods without accessing context or storage', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect((route as Record<string, unknown>)[method]).toBeUndefined();
    }
    const response = await route.POST(new Request(URL));
    await expectFailure(response, 405, 'method_not_allowed');
    expect(response.headers.get('allow')).toBe('POST');
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('returns a real-contract preview with explicitly read-only RPC arguments and the current cookie client', async () => {
    expect(isMoveDatePreview(preview())).toBe(true);
    expect(isMoveDateResult(result())).toBe(true);
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(result());
    expect(mocks.createServer).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.plan).toHaveBeenCalledExactlyOnceWith(db, FAMILY);
    expect(from).toHaveBeenCalledExactlyOnceWith('app_settings');
    expect(query.select).toHaveBeenCalledExactlyOnceWith('value');
    expect(query.eq).toHaveBeenCalledExactlyOnceWith('key', 'feature_tiers');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('move_recalculate_date', {
      p_family_id: FAMILY, p_move_id: MOVE, p_member_id: MEMBER, p_new_date: DATE,
      p_expected: null, p_request_id: null,
    });
  });

  it('applies only an explicit reviewed preview and UUID, passing the review unchanged', async () => {
    const reviewed = preview();
    rpc.mockResolvedValue({ data: result(true, reviewed), error: null });
    const response = await route.POST(request(applyBody(reviewed)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(result(true, reviewed));
    expect(rpc).toHaveBeenCalledExactlyOnceWith('move_recalculate_date', {
      p_family_id: FAMILY, p_move_id: MOVE, p_member_id: MEMBER, p_new_date: DATE,
      p_expected: reviewed, p_request_id: REQUEST,
    });
  });

  it('accepts an identical idempotent replay and returns its original applied timestamp', async () => {
    const applied = result(true);
    rpc.mockResolvedValue({ data: applied, error: null });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await route.POST(request(applyBody()));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(applied);
    }
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const [, args] of rpc.mock.calls) {
      expect(args.p_request_id).toBe(REQUEST);
      expect(args.p_expected).toEqual(preview());
    }
  });

  it('compares reviewed JSON by content even when the RPC reorders object keys', async () => {
    const reordered = Object.fromEntries(Object.entries(preview()).reverse());
    rpc.mockResolvedValue({ data: { ...result(true), preview: reordered }, error: null });
    expect((await route.POST(request(applyBody()))).status).toBe(200);
  });

  it.each(['0001-01-01', '9999-12-31', '2000-02-29', '2024-02-29'])('accepts the valid calendar date %s without timezone conversion', async (date) => {
    rpc.mockResolvedValue({ data: result(false, preview({ toDate: date, tasks: [], changes: 0 })), error: null });
    expect((await route.POST(request(bodyFor({ date })))).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_new_date).toBe(date);
  });

  it.each([
    '', '2026-9-30', '2026-09-3', '2026-02-29', '1900-02-29', '2024-02-30', '2026-04-31',
    '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '10000-01-01',
    '2026-09-30T00:00:00', '2026-09-30T00:00:00Z', '2026-09-30T00:00:00-04:00',
    ' 2026-09-30', '2026-09-30 ', null, 20260930,
  ])('rejects invalid, impossible or time-bearing date %s before database access', async (date) => {
    await expectFailure(await route.POST(request(bodyFor({ date }))), 400, 'invalid_request');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(['', 'not-a-uuid', '{' + MOVE + '}', MOVE.replaceAll('-', ''), MOVE + ' ', 1, null])('rejects noncanonical move UUID %s', async (moveId) => {
    await expectFailure(await route.POST(request(bodyFor({ moveId }))), 400, 'invalid_request');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(['', '{', 'null', '[]', 'true', '42', '"text"'])('rejects malformed or non-object JSON %s', async (text) => {
    await expectFailure(await route.POST(new Request(URL, { method: 'POST', body: text })), 400, 'invalid_body');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('rejects an absent body, invalid UTF-8 and a failed body stream', async () => {
    const failedStream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(PRIVATE_DETAIL)); } });
    const requests = [
      new Request(URL, { method: 'POST' }),
      new Request(URL, { method: 'POST', body: new Uint8Array([0xc3, 0x28]) }),
      new Request(URL, { method: 'POST', body: failedStream, duplex: 'half' } as RequestInit & { duplex: 'half' }),
    ];
    for (const input of requests) await expectFailure(await route.POST(input), 400, 'invalid_body');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('enforces actual streamed UTF-8 byte size with content-length %s', async (declaredLength) => {
    const text = JSON.stringify(bodyFor({ padding: '\u00e9'.repeat(LIMIT / 2) }));
    expect(text.length).toBeLessThan(LIMIT);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(LIMIT);
    await expectFailure(await route.POST(streamRequest(text, declaredLength)), 413, 'body_too_large');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body early and accepts a valid body of exactly 1 MiB', async () => {
    await expectFailure(await route.POST(streamRequest(JSON.stringify(bodyFor()), String(LIMIT + 1))), 413, 'body_too_large');
    expect(mocks.createServer).not.toHaveBeenCalled();
    const text = JSON.stringify(bodyFor());
    expect((await route.POST(streamRequest(' '.repeat(LIMIT - text.length) + text))).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each(['tasks', 'title', 'owners', 'status', 'notes', 'boxes', 'newDate', 'apply'])('rejects independent task writes or unknown field %s', async (key) => {
    await expectFailure(await route.POST(request(bodyFor({ [key]: [] }))), 400, 'invalid_body');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each([
    { expected: preview() },
    { requestId: REQUEST },
    { expected: null, requestId: null },
    { expected: preview(), requestId: '' },
    { expected: preview(), requestId: 'not-a-uuid' },
    { expected: preview(), requestId: REQUEST.replaceAll('-', '') },
  ])('rejects an unpaired or invalid apply request %#', async (fields) => {
    const response = await route.POST(request(bodyFor(fields)));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('error');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each([
    { familyId: OTHER }, { memberId: OTHER }, { moveId: OTHER }, { toDate: '2026-10-01' },
    { version: 2 }, { tasks: null }, { changes: -1 }, { changes: 0.5 },
    { moveUpdatedAt: '2026-09-06T12:00:00' }, { moveUpdatedAt: 'invalid' },
    { fromDate: '2026-02-29' }, { extra: true },
  ])('rejects a malformed or mismatched reviewed preview %#', async (fields) => {
    await expectFailure(await route.POST(request(applyBody({ ...preview(), ...fields }))), 400, 'invalid_expected');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('rejects missing preview fields and malformed task shapes through the real validator', async () => {
    const { moveUpdatedAt: omitted, ...incomplete } = preview();
    expect(omitted).toBe(STAMP);
    await expectFailure(await route.POST(request(applyBody(incomplete))), 400, 'invalid_expected');
    const invalidTasks = [
      { offsetDays: 366 }, { offsetDays: -366 }, { offsetDays: 0.5 }, { mode: 'legacy' },
      { status: 'complete' }, { dueDate: '2026-02-29' }, { nextDueDate: '10000-01-01' },
      { updatedAt: '2026-09-06T12:00:00' }, { action: 'delete' }, { reason: 'unknown' },
      { id: 'bad-id' }, { title: 4 }, { owner: OTHER },
    ];
    for (const fields of invalidTasks) {
      const reviewed = preview();
      const invalid = { ...reviewed, tasks: [{ ...reviewed.tasks[0], ...fields }, ...reviewed.tasks.slice(1)] };
      await expectFailure(await route.POST(request(applyBody(invalid))), 400, 'invalid_expected');
    }
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(['familyId', 'memberId'])('requires an exact current %s, including on apply', async (key) => {
    for (const value of [undefined, null, '', 'bad-id', OTHER]) {
      await expectFailure(await route.POST(request({ ...applyBody(), [key]: value })), 403, 'context_changed');
    }
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(['parent', 'adult'])('permits an active %s membership', async (role) => {
    mocks.context.mockResolvedValue(contextFor(role));
    expect((await route.POST(request())).status).toBe(200);
  });

  it.each(['child', 'teen', 'caregiver', 'guest', 'unknown'])('refuses %s before creating a client, including for super-admin accounts', async (role) => {
    mocks.context.mockResolvedValue(contextFor(role));
    mocks.superAdmin.mockResolvedValue(true);
    await expectFailure(await route.POST(request(applyBody())), 403, 'role_required');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('refuses signed-out and familyless requests', async () => {
    mocks.context.mockResolvedValue(null);
    await expectFailure(await route.POST(request()), 401, 'signed_out');
    mocks.context.mockResolvedValue({ needsFamily: true });
    await expectFailure(await route.POST(request()), 403, 'needs_family');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each([null, { id: MEMBER, is_active: false }, { id: MEMBER }, { is_active: true }])('requires a present, explicitly active member %#', async (member) => {
    mocks.context.mockResolvedValue({ ...contextFor(), active: { ...contextFor().active, member } });
    await expectFailure(await route.POST(request()), 403, 'membership_required');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each(['family', 'member'])('refuses an apply after the active %s switches', async (changed) => {
    const current = contextFor();
    if (changed === 'family') current.active.familyId = OTHER;
    else current.active.member.id = OTHER;
    mocks.context.mockResolvedValue(current);
    await expectFailure(await route.POST(request(applyBody())), 403, 'context_changed');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('honors the exact moving feature key and prevents disabled-feature RPC access', async () => {
    setting.data = { value: { 'move-planner': 'off' } };
    await expectFailure(await route.POST(request()), 404, 'feature_off');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('enforces the default basic plan and an overridden plus tier', async () => {
    mocks.plan.mockResolvedValue(0);
    await expectFailure(await route.POST(request()), 403, 'plan_required');
    mocks.plan.mockResolvedValue(1);
    setting.data = { value: { 'move-planner': 'plus' } };
    await expectFailure(await route.POST(request()), 403, 'plan_required');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retains the existing super-admin feature preview behavior after membership checks', async () => {
    mocks.superAdmin.mockResolvedValue(true);
    setting.data = { value: { 'move-planner': 'off' } };
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('fails closed when feature settings cannot be read', async () => {
    setting.error = { code: '42501', message: PRIVATE_DETAIL };
    await expectFailure(await route.POST(request()), 503, 'access_unavailable');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([[], 'off', { 'move-planner': 'invalid' }, { 'move-planner': false }])('fails closed on malformed moving configuration %#', async (value) => {
    setting.data = { value };
    await expectFailure(await route.POST(request()), 503, 'access_unavailable');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([undefined, null, NaN, Infinity, -1, 0.5, 3])('fails closed on an unavailable or invalid plan level %s', async (level) => {
    mocks.plan.mockResolvedValue(level);
    await expectFailure(await route.POST(request()), 503, 'access_unavailable');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['40001', 409, 'stale_review'],
    ['23505', 409, 'idempotency_conflict'],
    ['42501', 403, 'authorization'],
    ['P0002', 404, 'move_unavailable'],
    ['22023', 400, 'invalid_request'],
    ['54000', 422, 'coverage_limit'],
    ['42883', 503, 'schema_unavailable'],
    ['42703', 503, 'schema_unavailable'],
    ['42P01', 503, 'schema_unavailable'],
    ['3F000', 503, 'schema_unavailable'],
    ['PGRST002', 503, 'schema_unavailable'],
    ['PGRST202', 503, 'schema_unavailable'],
    ['PGRST203', 503, 'schema_unavailable'],
    ['PGRST204', 503, 'schema_unavailable'],
    ['PGRST205', 503, 'schema_unavailable'],
    ['XX000', 503, 'recalculation_unavailable'],
  ] as const)('maps RPC error %s safely, without retry or direct-write fallback', async (sqlCode, status, code) => {
    rpc.mockResolvedValue({ data: null, error: { code: sqlCode, message: PRIVATE_DETAIL, details: PRIVATE_DETAIL, hint: PRIVATE_DETAIL } });
    await expectFailure(await route.POST(request(applyBody())), status, code);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_expected).toEqual(preview());
    expect(rpc.mock.calls[0][1].p_request_id).toBe(REQUEST);
    expect(from).toHaveBeenCalledExactlyOnceWith('app_settings');
  });

  it('treats a foreign or unavailable move as unavailable during preview', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: PRIVATE_DETAIL } });
    await expectFailure(await route.POST(request()), 404, 'move_unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_expected).toBeNull();
  });

  it.each([null, [], {}, { preview: preview() }, { ...result(), applied: 'false' }])('fails closed on malformed RPC result %#', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expectFailure(await route.POST(request()), 503, 'invalid_result');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { familyId: OTHER }, { memberId: OTHER }, { moveId: OTHER }, { toDate: '2026-10-01' },
    { version: 2 }, { tasks: null }, { fromDate: '0000-01-01' },
  ])('does not return malformed or incorrectly scoped RPC preview %#', async (fields) => {
    rpc.mockResolvedValue({ data: { ...result(), preview: { ...preview(), ...fields } }, error: null });
    await expectFailure(await route.POST(request()), 503, 'invalid_result');
  });

  it.each([
    { applied: true }, { requestId: REQUEST }, { appliedAt: APPLIED_AT },
    { appliedAt: undefined }, { requestId: undefined },
  ])('rejects an apply flag or request metadata on a preview response %#', async (fields) => {
    rpc.mockResolvedValue({ data: { ...result(), ...fields }, error: null });
    await expectFailure(await route.POST(request()), 503, 'invalid_result');
  });

  it.each([
    { applied: false }, { requestId: null }, { requestId: OTHER },
    { appliedAt: null }, { appliedAt: '2026-09-06T12:05:00' },
  ])('rejects incorrect apply response metadata %#', async (fields) => {
    rpc.mockResolvedValue({ data: { ...result(true), ...fields }, error: null });
    await expectFailure(await route.POST(request(applyBody())), 503, 'invalid_result');
  });

  it('rejects an apply response that substitutes a fresh preview even if its outer scope matches', async () => {
    const different = preview();
    different.tasks[0].title = 'A changed task title';
    rpc.mockResolvedValue({ data: result(true, different), error: null });
    await expectFailure(await route.POST(request(applyBody())), 503, 'invalid_result');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_expected).toEqual(preview());
  });

  it('returns safe, uncached failures for context, feature-plan and RPC exceptions', async () => {
    mocks.context.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));
    await expectFailure(await route.POST(request()), 503, 'recalculation_unavailable');
    mocks.plan.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));
    await expectFailure(await route.POST(request()), 503, 'recalculation_unavailable');
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));
    await expectFailure(await route.POST(request()), 503, 'recalculation_unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
