import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/email/invite read the invite by id and family only. Any member (a child,
// a guest) could re-mail any invite in the family — revoked, accepted or
// expired — as a fresh "Accept invitation" email, spending the family's shared
// 20/hour budget. And an adult could mail a `parent` invite they had written
// straight through PostgREST (invites_insert is only can_manage_family).

const state = vi.hoisted(() => ({
  role: 'parent' as string,
  invite: null as Record<string, unknown> | null,
  sent: [] as unknown[],
  limited: 0,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u' },
    active: { familyId: 'f', role: state.role, member: { display_name: 'Casey' }, family: { name: 'Rivera family' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: () => {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: state.invite, error: null }) };
    return b;
  } }),
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => { state.limited++; return { ok: true }; },
}));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async (args: unknown) => { state.sent.push(args); return { ok: true }; },
}));

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();
const invite = (over: Record<string, unknown> = {}) => ({
  id: 'i', email: 'grandma@example.test', token: 't', role: 'guest', status: 'pending', expires_at: future(), ...over,
});

async function post() {
  const { POST } = await import('@/app/api/email/invite/route');
  return POST(new NextRequest('https://www.bubaly.com/api/email/invite', {
    method: 'POST', body: JSON.stringify({ inviteId: 'i' }), headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => { state.role = 'parent'; state.invite = invite(); state.sent = []; state.limited = 0; });

describe('/api/email/invite', () => {
  it('mails a pending, unexpired invite for a manager (control)', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.sent).toHaveLength(1);
  });

  it.each(['child', 'guest', 'teen', 'caregiver'])('refuses a %s caller without spending the family budget', async (role) => {
    state.role = role;
    const res = await post();
    expect(res.status).toBe(403);
    expect(state.sent).toHaveLength(0);
    expect(state.limited).toBe(0);
  });

  it.each([
    ['revoked', { status: 'revoked' }],
    ['accepted', { status: 'accepted' }],
    ['expired', { expires_at: past() }],
  ])('refuses a %s invite', async (_label, over) => {
    state.invite = invite(over);
    const res = await post();
    expect(res.status).toBe(409);
    expect(state.sent).toHaveLength(0);
    expect(state.limited).toBe(0);
  });

  it('refuses to mail a parent invite for an adult', async () => {
    state.role = 'adult';
    state.invite = invite({ role: 'parent' });
    const res = await post();
    expect(res.status).toBe(403);
    expect(state.sent).toHaveLength(0);
  });

  it('a parent may still mail a parent invite', async () => {
    state.invite = invite({ role: 'parent' });
    expect((await post()).status).toBe(200);
    expect(state.sent).toHaveLength(1);
  });
});
