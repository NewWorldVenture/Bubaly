// POST /api/push/test (Register B API-818E7ADDB5D4): who may send a test push
// and to whom. The real getUser reads the session from the in-memory
// database; the durable limiter is real; the sender (lib/server/push) is
// stubbed at the seam tests/push-is-on-only-when-the-server-holds-the-device
// already stubs, because device dispatch is open PR #1172's.
//
// Already proven elsewhere and not repeated:
//  - tests/push-delivery-retry.test.ts: 401 for an anonymous caller, 502 on a
//    provider failure, 409 with no registration and 200 after one, all through
//    the real sender.
//  - tests/push-is-on-only-when-the-server-holds-the-device.test.ts: a
//    consent read that failed is a 503 with a translated reason.
//
// Added here: every member role sends only to their own account; a body naming
// household B's account is ignored; unconfigured push and the rate limit
// reach no provider; the 503 answer carries no internal error text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn(), configured: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true, retryAfter: 0 }) }));
vi.mock('@/lib/server/push', async (original) => ({
  ...await original<typeof import('@/lib/server/push')>(),
  sendPushToUser: state.send, pushConfigured: state.configured,
}));

const { POST } = await import('@/app/api/push/test/route');
const { PushPreparationError } = await import('@/lib/server/push');

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userOf = (h: 'A' | 'B', role: string) => `user-${h}-${role}`;
const SENT = { sent: 1, failed: 0, skipped: 0, pruned: 0, withheld: 0 };

function database(userId: string | null) {
  const db = createInMemorySupabase({ userId, rpc: { rate_limit_hit: rateLimitHit } });
  for (const [h, familyId] of [['A', '0a000000-0000-4000-8000-0000000000a3'], ['B', '0b000000-0000-4000-8000-0000000000b3']] as const) {
    db.seed('family_members', ROLES.map((role) => ({ id: `member-${h}-${role}`, family_id: familyId, user_id: userOf(h, role), role, is_active: true })));
  }
  state.db = db;
  return db;
}

/** The route takes no body; this one names household B's parent and must be ignored. */
const testPush = () => (POST as unknown as (req: Request) => Promise<Response>)(new Request('https://bubaly.example.com/api/push/test', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: userOf('B', 'parent'), user_id: userOf('B', 'parent') }),
}));

beforeEach(() => {
  state.send.mockReset().mockResolvedValue(SENT);
  state.configured.mockReset().mockReturnValue({ web: true, native: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('who may send a test push, and to whom', () => {
  it('API-818E7ADDB5D4 a signed-out caller gets 401, spends no budget and reaches no provider', async () => {
    const db = database(null);
    const res = await testPush();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'test.unauthorized' });
    expect(state.send).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toEqual([]);
  });

  it.each(ROLES)('API-818E7ADDB5D4 %s of household A sends to their own account only, whatever the body names', async (role) => {
    const db = database(userOf('A', role));
    const res = await testPush();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: SENT, configured: { web: true, native: true } });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0]).toBe(db);
    expect(state.send.mock.calls[0][1]).toBe(userOf('A', role));
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`push:test:${userOf('A', role)}`]);
  });

  it('API-818E7ADDB5D4 a server with no push configured answers 503 and reaches no provider', async () => {
    const db = database(userOf('A', 'parent'));
    state.configured.mockReturnValue({ web: false, native: false });
    const res = await testPush();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'test.pushIsnTConfiguredOn', configured: { web: false, native: false } });
    expect(state.send).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toEqual([]);
  });

  it('API-818E7ADDB5D4 the sixth test push in a minute is 429 and reaches no provider', async () => {
    database(userOf('A', 'teen'));
    for (let i = 0; i < 5; i++) expect((await testPush()).status).toBe(200);
    const res = await testPush();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(state.send).toHaveBeenCalledTimes(5);
  });
});

describe('a read that fails', () => {
  it('API-818E7ADDB5D4 a push preparation that could not read settings is 503 and says nothing of the internal error', async () => {
    database(userOf('A', 'child'));
    state.send.mockRejectedValue(new PushPreparationError('INTERNAL consent relation detail'));
    const res = await testPush();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'test.couldNotCheckPushSettings' });
    expect(text).not.toContain('INTERNAL');
  });

  it('API-818E7ADDB5D4 a send that reached no device is not reported as ok', async () => {
    database(userOf('A', 'guest'));
    state.send.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, pruned: 0, withheld: 0 });
    const res = await testPush();
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBe(false);
  });
});
