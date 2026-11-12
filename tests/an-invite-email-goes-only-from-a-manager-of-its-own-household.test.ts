// POST /api/email/invite, driven end to end (Register B API-1AC88B3A7ED8).
//
// The real route, the real getUserContext/requireUserContext and the real
// limiter run over an in-memory database seeded with TWO households. Only the
// mail seam is replaced (`@/lib/email`'s sendReactEmail, the seam
// tests/only-a-manager-mails-a-live-invite.test.ts and
// tests/an-email-nobody-sent-is-not-reported-as-sent.test.ts stub), so "a mail
// was sent" is a call that reached it.
//
// Already proven elsewhere and not repeated: revoked/accepted/expired invites
// and the adult→parent rank rule (only-a-manager-mails-a-live-invite), the
// no-provider 503 (an-invite-with-no-mail-provider-is-not-sent), a kid-login
// address (no-mail-goes-to-a-kid-login-address), and the limiter's placement
// and family key (outbound-email-is-rate-limited, a-signed-in-rate-limit-key-
// names-the-caller — both source scans). What this adds is the route over real
// rows: who may call it as resolved from family_members, the invite of
// another household, a failed read, and the durable family budget.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, send: vi.fn() }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/email', () => ({ sendReactEmail: h.send }));

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const USER = {
  parent: 'aaaaaaaa-0000-4000-8000-000000000101',
  adult: 'aaaaaaaa-0000-4000-8000-000000000102',
  teen: 'aaaaaaaa-0000-4000-8000-000000000103',
  child: 'aaaaaaaa-0000-4000-8000-000000000104',
  caregiver: 'aaaaaaaa-0000-4000-8000-000000000105',
  guest: 'aaaaaaaa-0000-4000-8000-000000000106',
} as const;
const USER_B_PARENT = 'bbbbbbbb-0000-4000-8000-000000000201';
const MEMBER_B_PARENT = 'bbbbbbbb-0000-4000-8000-000000000301';
const INVITE_A = 'aaaaaaaa-0000-4000-8000-000000000401';
const INVITE_B = 'bbbbbbbb-0000-4000-8000-000000000402';
const NOW = new Date('2026-10-12T10:05:00Z');
const LIVE = '2026-10-19T10:05:00Z';

let db: InMemorySupabase;

function boot(userId: string | null) {
  db = createInMemorySupabase({ userId, rpc: { rate_limit_hit: rateLimitHit } });
  db.seed('families', [
    { id: FAMILY_A, name: 'Rivera family', closed_at: null },
    { id: FAMILY_B, name: 'Okafor family', closed_at: null },
  ]);
  db.seed('family_members', [
    ...Object.entries(USER).map(([role, user_id], i) => ({
      id: `aaaaaaaa-0000-4000-8000-00000000030${i + 1}`, family_id: FAMILY_A, user_id, role,
      display_name: `Casey ${role}`, is_active: true, created_at: `2026-01-0${i + 1}T00:00:00Z`,
    })),
    { id: MEMBER_B_PARENT, family_id: FAMILY_B, user_id: USER_B_PARENT, role: 'parent', display_name: 'Ngozi', is_active: true },
  ]);
  db.seed('invites', [
    { id: INVITE_A, family_id: FAMILY_A, email: 'grandma@example.com', token: 'tok-a-fixture', role: 'guest', status: 'pending', expires_at: LIVE },
    { id: INVITE_B, family_id: FAMILY_B, email: 'okafor-aunt@example.com', token: 'tok-b-fixture', role: 'adult', status: 'pending', expires_at: LIVE },
  ]);
  h.db = db;
}

async function post(inviteId: string) {
  const { POST } = await import('@/app/api/email/invite/route');
  return POST(new NextRequest('https://www.bubaly.com/api/email/invite', {
    method: 'POST', body: JSON.stringify({ inviteId }), headers: { 'content-type': 'application/json' },
  }));
}

const invitesSnapshot = () => JSON.stringify(db.table('invites'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules(); // a fresh per-instance limiter for every case
  h.send.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('who may mail an invite', () => {
  it('API-1AC88B3A7ED8 signed-out caller is refused at the handler, mails nothing and spends no budget', async () => {
    boot(null);
    const before = invitesSnapshot();
    const res = await post(INVITE_A);
    // requireUserContext redirects to /login; the route's catch turns that
    // throw into its generic 500 (middleware answers 307 before this in a deployment).
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'invite.failedToSendInvite' });
    expect(h.send).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toHaveLength(0);
    expect(invitesSnapshot()).toBe(before);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)(
    'API-1AC88B3A7ED8 a %s of the household is refused 403, mails nothing and spends no budget',
    async (role) => {
      boot(USER[role]);
      const before = invitesSnapshot();
      const res = await post(INVITE_A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invite.invalidInvite' });
      expect(h.send).not.toHaveBeenCalled();
      expect(db.table('rate_limits')).toHaveLength(0);
      expect(invitesSnapshot()).toBe(before);
    },
  );

  it.each([
    ['household B\'s invite id', INVITE_B],
    ['an id that names no invite', 'aaaaaaaa-0000-4000-8000-0000000004ff'],
  ])('API-1AC88B3A7ED8 a child sending %s is refused 403 before any invite is read, so it cannot probe which ids exist', async (_label, id) => {
    boot(USER.child);
    const res = await post(id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invite.invalidInvite' });
    expect(db.log.map((entry) => entry.table)).not.toContain('invites');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('API-1AC88B3A7ED8 a parent mails their own household\'s live invite, with its token, and spends one hit of the family budget', async () => {
    boot(USER.parent);
    const res = await post(INVITE_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    const [message] = h.send.mock.calls[0] as [{ to: string; subject: string; react: { props: Record<string, unknown> } }];
    expect(message.to).toBe('grandma@example.com');
    expect(message.subject).toBe('Casey parent invited you to join Rivera family on Bubaly');
    expect(message.react.props).toEqual({ familyName: 'Rivera family', inviterName: 'Casey parent', token: 'tok-a-fixture', role: 'guest' });
    expect(db.table('rate_limits').map((r) => [r.bucket_key, r.count])).toEqual([[`email:invite:${FAMILY_A}`, 1]]);
    // Mailing is a read: the invite row is not changed.
    expect(db.table('invites').find((r) => r.id === INVITE_A)).toMatchObject({ status: 'pending', expires_at: LIVE, token: 'tok-a-fixture' });
  });

  it('API-1AC88B3A7ED8 an adult of the household may mail the same guest invite', async () => {
    boot(USER.adult);
    const res = await post(INVITE_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((h.send.mock.calls[0] as [{ to: string }])[0].to).toBe('grandma@example.com');
  });
});

describe('another household\'s ids', () => {
  it.each([
    ['invite id', INVITE_B],
    ['member id', MEMBER_B_PARENT],
  ])('API-1AC88B3A7ED8 a parent of A sending household B\'s %s gets 404, B\'s invite is not mailed and nothing of B is returned', async (_label, id) => {
    boot(USER.parent);
    const before = invitesSnapshot();
    const res = await post(id);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'invite.inviteNotFound' });
    expect(text).not.toContain('okafor');
    expect(text).not.toContain('tok-b-fixture');
    expect(h.send).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toHaveLength(0);
    expect(invitesSnapshot()).toBe(before);
  });

  it('API-1AC88B3A7ED8 B\'s own parent still mails B\'s invite (control)', async () => {
    boot(USER_B_PARENT);
    const res = await post(INVITE_B);
    expect(res.status).toBe(200);
    expect((h.send.mock.calls[0] as [{ to: string }])[0].to).toBe('okafor-aunt@example.com');
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`email:invite:${FAMILY_B}`]);
  });
});

describe('failure', () => {
  it('API-1AC88B3A7ED8 a failed invite read answers 503 unavailable, not "not found", leaks nothing and mails nothing', async () => {
    boot(USER.parent);
    h.db = withFaults(db, (table) => (table === 'invites' ? { code: '57014', message: 'canceling statement due to statement timeout on invites_pkey' } : null));
    const res = await post(INVITE_A);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'invite.inviteDataIsTemporarilyUnavailable' });
    expect(text).not.toContain('statement timeout');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('API-1AC88B3A7ED8 a provider that refuses the mail answers 502, never sent:true', async () => {
    boot(USER.parent);
    h.send.mockResolvedValue({ ok: false });
    const res = await post(INVITE_A);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'invite.failedToSendInvite' });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('API-1AC88B3A7ED8 a limiter that cannot be evaluated refuses 429 and mails nothing (fails closed)', async () => {
    boot(USER.parent);
    db = createInMemorySupabase({ userId: USER.parent }); // no rate_limit_hit: the RPC answers an error
    const seeded = h.db as InMemorySupabase;
    for (const t of ['families', 'family_members', 'invites']) db.seed(t, seeded.table(t));
    h.db = db;
    const res = await post(INVITE_A);
    expect(res.status).toBe(429);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('API-1AC88B3A7ED8 a household whose hourly budget of 20 is spent gets 429 with Retry-After and no mail', async () => {
    boot(USER.parent);
    const windowStart = Math.floor(NOW.getTime() / 1000 / 3600) * 3600;
    db.seed('rate_limits', [{ bucket_key: `email:invite:${FAMILY_A}`, window_start: windowStart, count: 20 }]);
    const res = await post(INVITE_A);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: 'requests.tooManyRequestsPleaseTry' });
    expect(h.send).not.toHaveBeenCalled();
  });
});
