import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An invite email is sent by someone who may invite, and only for a live invite.
 *
 * `/api/email/invite` mails the address on an invite row, with the CALLER's
 * name as the inviter. It checked that the caller was signed in and that the
 * invite belonged to their family, and nothing else:
 *
 *  - Any member could call it — a child, a teen, a guest, a caregiver — though
 *    only a parent or adult may create an invite (`invites_insert` is
 *    `can_manage_family`). `invites_select` shows every member the family's
 *    invites, so a child could have Bubaly mail each one, "Sam invited you to
 *    join", and each send spent the FAMILY's 20-an-hour invite budget: the
 *    parent's own invite was then refused with "too many requests".
 *  - A revoked, accepted or expired invite was mailed like a live one and the
 *    route answered `{ sent: true }`; the link in it can only fail.
 *
 * Both refusals come before the budget is touched.
 */

const state = vi.hoisted(() => ({
  role: 'parent' as string,
  invite: null as Record<string, unknown> | null,
  sends: [] as Array<{ to: string }>,
  limited: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u1' },
    active: { familyId: 'f1', role: state.role, member: { display_name: 'Sam' }, family: { name: 'The Okafors' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, { select: () => b, eq: () => b, maybeSingle: async () => ({ data: state.invite, error: null }) });
      return b;
    },
  }),
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: async (_client: unknown, key: string) => { state.limited.push(key); return { ok: true }; },
}));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async (input: { to: string }) => { state.sends.push({ to: input.to }); return { ok: true }; },
}));

const { POST } = await import('@/app/api/email/invite/route');

const DAY = 86_400_000;
const liveInvite = () => ({
  id: 'inv-1', family_id: 'f1', email: 'grandma@example.test', token: 'tok', role: 'guest',
  status: 'pending', expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
});

async function send() {
  const res = await POST(new NextRequest('https://www.bubaly.com/api/email/invite', {
    method: 'POST', body: JSON.stringify({ inviteId: 'inv-1' }), headers: { 'content-type': 'application/json' },
  }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  state.role = 'parent';
  state.invite = liveInvite();
  state.sends = [];
  state.limited = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('who may have Bubaly mail an invite', () => {
  it.each(['child', 'teen', 'guest', 'caregiver'])('refuses a %s, before the family budget is spent', async (role) => {
    state.role = role;
    const { status, body } = await send();
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'actions.onlyAParentGuardianCan16' });
    expect(state.sends).toEqual([]);
    expect(state.limited).toEqual([]);
  });

  it.each(['parent', 'adult'])('lets a %s send it (control)', async (role) => {
    state.role = role;
    expect(await send()).toEqual({ status: 200, body: { sent: true } });
    expect(state.sends).toEqual([{ to: 'grandma@example.test' }]);
  });
});

describe('which invites may be mailed', () => {
  it.each(['revoked', 'accepted', 'expired'])('does not mail a %s invite', async (status) => {
    state.invite = { ...liveInvite(), status };
    const result = await send();
    expect(result).toEqual({ status: 409, body: { error: 'actions.inviteIsNoLongerPending' } });
    expect(state.sends).toEqual([]);
    expect(state.limited).toEqual([]);
  });

  it('does not mail a pending invite whose link has expired', async () => {
    state.invite = { ...liveInvite(), expires_at: new Date(Date.now() - 1000).toISOString() };
    expect(await send()).toEqual({ status: 409, body: { error: 'actions.inviteIsNoLongerPending' } });
    expect(state.sends).toEqual([]);
  });

  it('does not mail an invite whose expiry cannot be read', async () => {
    state.invite = { ...liveInvite(), expires_at: null };
    expect((await send()).status).toBe(409);
    expect(state.sends).toEqual([]);
  });
});
