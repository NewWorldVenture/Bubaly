// Assistant keys (the standing grant a speaker uses to act for a household),
// minted and revoked as each member of a household, and with another
// household's key id.
//
// THE POLICY. Only a parent: the action says so (app/(app)/dashboard/assistants/actions.ts
// `canManage` → isAdmin, lib/constants/roles.ts `isAdmin = role === 'parent'`),
// and the live table agrees — 0343_only_a_parent_mints_or_revokes_an_assistant_key.sql:75-91
// adds restrictive `is_family_admin(family_id)` guards on insert, update and
// delete. Both writes go through the SERVICE client (the row carries a secret
// hash), which no policy reaches, so the action's own role check and family
// filter are the only gates; this file pins them.
//
// WHAT IS ASSERTED, per role: the reply AND the assistant_links / audit_logs
// rows read back. A parent mints exactly one key for household A (hash stored,
// token returned once, never stored) and revokes only A's key; every other role
// is refused and nothing is written; an id from household B revokes nothing.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!mocks.ctx) throw new Error('redirect:/login');
    return mocks.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { createAssistantLinkAction, revokeAssistantLinkAction } = await import('@/app/(app)/dashboard/assistants/actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const KEY_A = 'c0c0c0c0-0000-4000-8000-00000000000a';
const KEY_B = 'c0c0c0c0-0000-4000-8000-00000000000b';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Caller = { role: string; member: string; user: string; email: string; name: string };
const CALLERS: Caller[] = [
  ...ROLES.map((role, i) => ({
    role, name: role, member: `aaaaaaaa-1111-4000-8000-00000000000${i + 1}`, user: `aaaaaaaa-2222-4000-8000-00000000000${i + 1}`, email: `${role}@example.com`,
  })),
  { role: 'child', name: 'child (kid login)', member: 'aaaaaaaa-1111-4000-8000-000000000009', user: 'aaaaaaaa-2222-4000-8000-000000000009', email: `kid@${CHILD_LOGIN_EMAIL_DOMAIN}` },
];
const PARENT = CALLERS[0];
const NOT_PARENTS = CALLERS.filter((c) => c.role !== 'parent');

let db: InMemorySupabase;

function signInAs(c: Caller) {
  mocks.ctx = {
    user: { id: c.user, email: c.email },
    active: { familyId: FAMILY_A, role: c.role, member: { id: c.member }, family: { id: FAMILY_A, timezone: 'UTC' } },
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const everything = () => structuredClone({ links: db.table('assistant_links'), audit: db.table('audit_logs') });

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  mocks.ctx = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('assistant_links', [
    { id: KEY_A, family_id: FAMILY_A, user_id: PARENT.user, provider: 'alexa', label: 'Kitchen', token_hash: 'hash-a', token_prefix: 'bub_a', scopes: ['ask'], revoked_at: null },
    { id: KEY_B, family_id: FAMILY_B, user_id: 'bbbbbbbb-2222-4000-8000-000000000001', provider: 'siri', label: 'Their phone', token_hash: 'hash-b', token_prefix: 'bub_b', scopes: ['ask'], revoked_at: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('createAssistantLinkAction', () => {
  it('ACTION-274EDFA6815C a parent mints one key for household A; only its hash is stored and the token is returned once', async () => {
    signInAs(PARENT);

    const res = await createAssistantLinkAction(form({ label: 'Living room', provider: 'google', allowCapture: 'on' }));

    expect(res.ok).toBe(true);
    const token = (res as { token: string }).token;
    expect(typeof token).toBe('string');
    const minted = db.table('assistant_links').filter((r) => r.id !== KEY_A && r.id !== KEY_B);
    expect(minted).toEqual([expect.objectContaining({
      family_id: FAMILY_A, user_id: PARENT.user, created_by: PARENT.user, provider: 'google', label: 'Living room',
      scopes: ['ask', 'capture'],
    })]);
    expect(minted[0].token_hash).not.toBe(token);
    expect(JSON.stringify(db.table('assistant_links'))).not.toContain(token);
    expect(minted[0].token_hash).toBe(createHash('sha256').update(token).digest('base64url'));
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY_A, action: 'create', resource: 'assistant_links' })]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/assistants');
  });

  it.each(NOT_PARENTS.map((c) => [c.name, c] as const))('ACTION-274EDFA6815C a %s is refused and no key is minted', async (_n, c) => {
    signInAs(c);
    const before = everything();

    expect(await createAssistantLinkAction(form({ label: 'Living room', provider: 'google', allowCapture: 'on' })))
      .toEqual({ ok: false, error: 'Only a parent can add an assistant.' });

    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-274EDFA6815C a signed-out caller is sent to sign in and no key is minted', async () => {
    const before = everything();
    await expect(createAssistantLinkAction(form({ label: 'Living room', provider: 'google' }))).rejects.toThrow('redirect:/login');
    expect(everything()).toEqual(before);
  });
});

describe('revokeAssistantLinkAction', () => {
  it('ACTION-1BD5BCD928F8 a parent revokes household A’s key and B’s key is untouched', async () => {
    signInAs(PARENT);
    const theirs = structuredClone(db.table('assistant_links').find((r) => r.id === KEY_B));

    const res = await revokeAssistantLinkAction(KEY_A);

    expect(res).toEqual({ ok: true, message: expect.any(String) });
    expect(typeof db.table('assistant_links').find((r) => r.id === KEY_A)?.revoked_at).toBe('string');
    expect(db.table('assistant_links').find((r) => r.id === KEY_B)).toEqual(theirs);
    expect(db.table('audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY_A, resource: 'assistant_links', resource_id: KEY_A })]);
  });

  it.each(NOT_PARENTS.map((c) => [c.name, c] as const))('ACTION-1BD5BCD928F8 a %s is refused and the key keeps working', async (_n, c) => {
    signInAs(c);
    const before = everything();

    expect(await revokeAssistantLinkAction(KEY_A)).toEqual({ ok: false, error: 'Only a parent can revoke an assistant.' });

    expect(everything()).toEqual(before);
    expect(db.table('assistant_links').find((r) => r.id === KEY_A)?.revoked_at).toBeNull();
  });

  it('ACTION-1BD5BCD928F8 a parent of A naming household B’s key revokes nothing in either household', async () => {
    signInAs(PARENT);
    const before = everything();

    expect(await revokeAssistantLinkAction(KEY_B)).toEqual({ ok: false, error: 'assistants.keyNotFoundNothingRevoked' });

    expect(everything()).toEqual(before);
    expect(db.table('assistant_links').find((r) => r.id === KEY_B)?.revoked_at).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-1BD5BCD928F8 a signed-out caller is sent to sign in and nothing is revoked', async () => {
    const before = everything();
    await expect(revokeAssistantLinkAction(KEY_A)).rejects.toThrow('redirect:/login');
    expect(everything()).toEqual(before);
  });
});
