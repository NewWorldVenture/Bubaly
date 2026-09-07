import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/vacations/confirmation-import/route';

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(), getUser: vi.fn(), preview: vi.fn(), apply: vi.fn(),
  admin: vi.fn(() => { throw new Error('Admin client is forbidden'); }),
  from: vi.fn(() => { throw new Error('Route must use the scoped service'); }),
}));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.getContext }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
  createServiceClient: mocks.admin,
}));
vi.mock('@/lib/services/trips/confirmation-import', () => ({
  previewConfirmationImport: mocks.preview, applyConfirmationImport: mocks.apply,
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const TRIP = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const OTHER = '88888888-8888-4888-8888-888888888888';
const LIMIT = 512 * 1024;

function fixture() {
  const source = { title: 'Dinner confirmation', text: 'Name: Dinner\nCode: ABC123\n' };
  const fields = {
    name: 'Dinner', kind: 'dining', location: 'Harbor', reservedAt: '2026-09-10T18:30:45.999-04:00',
    partySize: 4, confirmationCode: 'ABC123', booked: true,
  };
  const preview = {
    version: 1, familyId: FAMILY, memberId: MEMBER, vacationId: TRIP,
    trip: {
      id: TRIP, title: 'Family trip', startDate: '2026-09-09', endDate: '2026-09-12',
      timezone: 'America/New_York', status: 'planning', updatedAt: '2026-09-06T12:00:00.123456+00:00',
    },
    source: { ...source, sha256: createHash('sha256').update(source.text, 'utf8').digest('hex') },
    fields, itinerary: { date: '2026-09-10', startTime: '18:30:45', dayPart: 'evening' },
  };
  const result = { preview, applied: false, requestId: null, appliedAt: null, reservationId: null, itineraryItemId: null };
  const body = { action: 'preview', familyId: FAMILY, memberId: MEMBER, vacationId: TRIP, source, fields };
  return { body, preview, result };
}

function context() {
  const active = {
    familyId: FAMILY, role: 'parent',
    family: { id: FAMILY, timezone: 'America/New_York' },
    member: { id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true },
  };
  return { user: { id: USER, email: null }, active, memberships: [active] };
}
function request(body: unknown) {
  return new Request('http://localhost/api/vacations/confirmation-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function assertPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toContain('private');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
  mocks.getContext.mockResolvedValue(context());
  mocks.preview.mockResolvedValue({ ok: true, data: fixture().result });
  mocks.apply.mockResolvedValue({ ok: false, error: 'Trip changed.', code: 'conflict' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live providers'); }));
});
afterEach(() => {
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('POST confirmation import', () => {
  it('builds a member scope from the cookie context and returns a private preview', async () => {
    const f = fixture();
    const response = await POST(request(f.body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.result);
    assertPrivate(response);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      familyId: FAMILY, memberId: MEMBER, userId: USER, role: 'parent', actorKind: 'member',
    }), { vacationId: TRIP, source: f.body.source, fields: f.body.fields });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('sends only the exact reviewed apply arguments and preserves a complete saved receipt', async () => {
    const f = fixture();
    const receipt = {
      ...f.result, applied: true, requestId: REQUEST, appliedAt: '2026-09-06T12:01:02.123456+00:00',
      reservationId: '66666666-6666-4666-8666-666666666666',
      itineraryItemId: '77777777-7777-4777-8777-777777777777',
    };
    mocks.apply.mockResolvedValue({ ok: true, data: receipt });
    const body = { ...f.body, action: 'apply', expected: f.preview, requestId: REQUEST };
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    assertPrivate(response);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actorKind: 'member' }), {
      vacationId: TRIP, source: f.body.source, fields: f.body.fields, expected: f.preview, requestId: REQUEST,
    });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it.each(['familyId', 'memberId'])('denies a submitted %s different from active context', async (field) => {
    const response = await POST(request({ ...fixture().body, [field]: OTHER }));
    expect(response.status).toBe(403);
    assertPrivate(response);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  const changedContexts: [string, (ctx: ReturnType<typeof context>) => void][] = [
    ['member switched', (ctx) => { ctx.active.member.id = OTHER; }],
    ['member family switched', (ctx) => { ctx.active.member.family_id = OTHER; }],
    ['member user switched', (ctx) => { ctx.active.member.user_id = OTHER; }],
    ['family switched', (ctx) => { ctx.active.family.id = OTHER; }],
    ['inactive membership', (ctx) => { ctx.active.member.is_active = false; }],
    ['child role', (ctx) => { ctx.active.role = 'child'; ctx.active.member.role = 'child'; }],
    ['mismatched role', (ctx) => { ctx.active.member.role = 'adult'; }],
    ['authenticated user switched', (ctx) => { ctx.user.id = OTHER; }],
  ];
  it.each(changedContexts)('rejects apply after %s', async (_name, change) => {
    const f = fixture();
    expect((await POST(request(f.body))).status).toBe(200);
    const ctx = context();
    change(ctx);
    mocks.getContext.mockResolvedValue(ctx);
    const response = await POST(request({ ...f.body, action: 'apply', expected: f.preview, requestId: REQUEST }));
    expect(response.status).toBe(403);
    assertPrivate(response);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out cookie session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
    const response = await POST(request(fixture().body));
    expect(response.status).toBe(401);
    assertPrivate(response);
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it('does not provision a family for an incomplete account', async () => {
    mocks.getContext.mockResolvedValue({ needsFamily: true });
    const response = await POST(request(fixture().body));
    expect(response.status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('fails closed when authentication or active context cannot be resolved', async () => {
    mocks.getContext.mockRejectedValue(new Error('Sensitive database response'));
    const response = await POST(request(fixture().body));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Sensitive database response');
    assertPrivate(response);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_input', 400], ['unauthorized', 401], ['denied', 403],
    ['not_found', 404], ['conflict', 409], ['db', 503],
  ])('maps service %s to HTTP %s with no caching', async (code, status) => {
    mocks.preview.mockResolvedValue({ ok: false, code, error: 'Import unavailable.' });
    const response = await POST(request(fixture().body));
    expect(response.status).toBe(status);
    assertPrivate(response);
  });

  const invalidBodies: [string, (f: ReturnType<typeof fixture>) => unknown][] = [
    ['unknown action', (f) => ({ ...f.body, action: 'book' })],
    ['extra root field', (f) => ({ ...f.body, userId: USER })],
    ['preview carrying approval', (f) => ({ ...f.body, expected: f.preview })],
    ['preview carrying request UUID', (f) => ({ ...f.body, requestId: REQUEST })],
    ['apply without approval', (f) => ({ ...f.body, action: 'apply', requestId: REQUEST })],
    ['apply without UUID', (f) => ({ ...f.body, action: 'apply', expected: f.preview })],
    ['unreviewed booking status', (f) => ({ ...f.body, fields: { ...f.body.fields, booked: undefined } })],
    ['unknown source metadata', (f) => ({ ...f.body, source: { ...f.body.source, providerVerified: true } })],
    ['unknown confirmation field', (f) => ({ ...f.body, fields: { ...f.body.fields, price: 100 } })],
    ['source over character bound', (f) => ({ ...f.body, source: { ...f.body.source, text: 'a'.repeat(32769) } })],
    ['source over UTF-8 byte bound', (f) => ({ ...f.body, source: { ...f.body.source, text: '\u20ac'.repeat(22000) } })],
    ['invalid UUID', (f) => ({ ...f.body, vacationId: 'not-a-uuid' })],
    ['too many input subseconds', (f) => ({ ...f.body, fields: { ...f.body.fields, reservedAt: '2026-09-10T18:30:45.123456-04:00' } })],
  ];
  it.each(invalidBodies)('strictly rejects %s', async (_name, body) => {
    const response = await POST(request(body(fixture())));
    expect(response.status).toBe(400);
    assertPrivate(response);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid UTF-8 without service work', async () => {
    for (const body of ['{', new Uint8Array([0xff, 0xfe])]) {
      const response = await POST(new Request('http://localhost/api/vacations/confirmation-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }));
      expect(response.status).toBe(400);
      assertPrivate(response);
    }
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('accepts exactly 512 KiB of actual JSON bytes', async () => {
    const json = JSON.stringify(fixture().body);
    const response = await POST(new Request('http://localhost/api/vacations/confirmation-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: json + ' '.repeat(LIMIT - new TextEncoder().encode(json).byteLength),
    }));
    expect(response.status).toBe(200);
  });

  it.each([undefined, '1'])('bounds streamed bytes with content-length %s and cancels overflow', async (declared) => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(128 * 1024 + 1).fill(32));
      },
      cancel,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (declared) headers['Content-Length'] = declared;
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
    const response = await POST(new Request('http://localhost/api/vacations/confirmation-import', init));
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(6);
    assertPrivate(response);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('returns 409 for a stale apply without calling preview as a fallback', async () => {
    const f = fixture();
    const response = await POST(request({ ...f.body, action: 'apply', expected: f.preview, requestId: REQUEST }));
    expect(response.status).toBe(409);
    assertPrivate(response);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledOnce();
  });
});
