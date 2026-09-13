import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionMissingError, createClient, type User } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getSocialAccess, requireSocialPermission } from '@/lib/social/access';
import { ROLE_PERMISSIONS, SOCIAL_ROLES } from '@/lib/social/roles';

const mocks = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const member = (role = 'parent') => ({ family_id: FAMILY, user_id: USER, role, is_active: true });
const permission = (social_role = 'read_only') => ({ family_id: FAMILY, user_id: USER, social_role, status: 'active' });
type Reply = { rows: unknown[]; status?: number; error?: Record<string, unknown>; reject?: boolean };
let replies: Record<string, Reply>;
let requests: URL[];
let client: ReturnType<typeof createClient<Database>>;

beforeEach(() => {
  vi.restoreAllMocks();
  replies = { family_members: { rows: [member()] }, social_access_permissions: { rows: [] } };
  requests = [];
  client = createClient<Database>('https://synthetic.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const reply = replies[url.pathname.split('/').at(-1)!];
      if (!reply) throw new Error('Unexpected synthetic request');
      if (reply.reject) throw new DOMException('synthetic transport rejection', 'AbortError');
      return new Response(JSON.stringify(reply.error ?? reply.rows), {
        status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' },
      });
    } },
  });
  vi.spyOn(client.auth, 'getUser').mockResolvedValue({ data: { user: { id: USER } as User }, error: null });
  mocks.createServer.mockResolvedValue(client);
});

describe('actual social access resolution with the installed query client', () => {
  it('preserves a verified restrictive override instead of a parent default', async () => {
    replies.social_access_permissions.rows = [permission()];
    const access = await getSocialAccess(FAMILY);
    expect(access?.role).toBe('read_only');
    expect(access?.can('publish_posts')).toBe(false);
    await expect(requireSocialPermission(FAMILY, 'connect_accounts')).rejects.toMatchObject({ name: 'SocialAccessError' });
  });

  it.each(SOCIAL_ROLES)('preserves all verified permissions for %s', async (role) => {
    replies.social_access_permissions.rows = [permission(role)];
    const access = await getSocialAccess(FAMILY);
    expect(access?.permissions).toEqual(ROLE_PERMISSIONS[role]);
  });

  it.each([
    ['parent', 'admin'], ['adult', 'marketing_manager'], ['teen', 'content_creator'],
    ['child', 'read_only'], ['caregiver', 'read_only'], ['guest', 'read_only'],
  ])('allows the %s default only after a clean absent override', async (household, social) => {
    replies.family_members.rows = [member(household)];
    expect((await getSocialAccess(FAMILY))?.role).toBe(social);
    for (const url of requests) {
      expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
      expect(url.searchParams.get('user_id')).toBe(`eq.${USER}`);
    }
    expect(requests.find((url) => url.pathname.endsWith('family_members'))?.searchParams.get('is_active')).toBe('eq.true');
    expect(requests.find((url) => url.pathname.endsWith('social_access_permissions'))?.searchParams.get('status')).toBe('eq.active');
  });

  it.each(['family_members', 'social_access_permissions'])('raises when required %s reports a database failure', async (table) => {
    replies.social_access_permissions.rows = [permission('owner')];
    replies[table] = { rows: [], status: 400, error: { code: '42P01', message: 'synthetic private diagnostic' } };
    await expect(requireSocialPermission(FAMILY, 'publish_posts')).rejects.toMatchObject({
      name: 'SocialAccessUnavailableError', message: 'Social access is temporarily unavailable.',
    });
  });

  it.each(['family_members', 'social_access_permissions'])('raises on a %s transport failure', async (table) => {
    replies.social_access_permissions.rows = [permission('owner')];
    replies[table] = { rows: [], reject: true };
    await expect(requireSocialPermission(FAMILY, 'connect_accounts')).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
  });

  it('also handles a rejected permission query promise instead of falling back', async () => {
    const original = client.from.bind(client);
    vi.spyOn(client, 'from').mockImplementation(((table: string) => {
      const query = original(table as 'social_access_permissions');
      if (table === 'social_access_permissions') {
        const select = query.select.bind(query);
        vi.spyOn(query, 'select').mockImplementation(((columns: string) => {
          const filtered = select(columns);
          vi.spyOn(filtered, 'maybeSingle').mockRejectedValue(new Error('synthetic rejected query'));
          return filtered;
        }) as typeof query.select);
      }
      return query;
    }) as typeof client.from);
    await expect(requireSocialPermission(FAMILY, 'publish_posts')).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
  });

  it('denies a missing active membership even with an explicit owner row', async () => {
    replies.family_members.rows = [];
    replies.social_access_permissions.rows = [permission('owner')];
    expect(await getSocialAccess(FAMILY)).toBeNull();
  });

  it.each([
    { family_id: OTHER }, { user_id: OTHER }, { is_active: false },
  ])('rejects returned membership outside the verified query scope: %j', async (change) => {
    replies.family_members.rows = [{ ...member(), ...change }];
    replies.social_access_permissions.rows = [permission('owner')];
    await expect(getSocialAccess(FAMILY)).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
  });

  it.each([
    { family_id: OTHER }, { user_id: OTHER }, { status: 'revoked' }, { social_role: 'unknown' },
  ])('rejects an invalid explicit permission instead of falling back: %j', async (change) => {
    replies.social_access_permissions.rows = [{ ...permission(), ...change }];
    await expect(getSocialAccess(FAMILY)).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
  });

  it.each(['family_members', 'social_access_permissions'])('rejects ambiguous %s rows through real maybeSingle', async (table) => {
    replies[table].rows = table === 'family_members' ? [member(), member()] : [permission(), permission('owner')];
    await expect(getSocialAccess(FAMILY)).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
  });

  it('does not derive social membership from super-admin metadata', async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: {
      id: USER, app_metadata: { is_super_admin: true }, user_metadata: { role: 'owner' },
    } as unknown as User }, error: null });
    replies.family_members.rows = [];
    expect(await getSocialAccess(FAMILY)).toBeNull();
  });

  it('returns no access for an ordinary missing session without reading private tables', async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    expect(await getSocialAccess(FAMILY)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('rejects an auth failure even if a user is included with the error', async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: { id: USER } as User },
      error: { name: 'AuthRetryableFetchError', message: 'synthetic auth diagnostic' } as never });
    await expect(getSocialAccess(FAMILY)).rejects.toMatchObject({ name: 'SocialAccessUnavailableError' });
    expect(requests).toHaveLength(0);
  });

  it('sanitizes thrown auth failures', async () => {
    vi.mocked(client.auth.getUser).mockRejectedValue(new Error('synthetic auth diagnostic'));
    await expect(getSocialAccess(FAMILY)).rejects.toMatchObject({
      name: 'SocialAccessUnavailableError', message: 'Social access is temporarily unavailable.',
    });
    expect(requests).toHaveLength(0);
  });
});
