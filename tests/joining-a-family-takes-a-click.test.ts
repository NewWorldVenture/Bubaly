// A18 — /join accepted the invite on page load.
//
// JoinInvite called rpc('accept_invite') from its mount effect, so any page
// that top-level redirected a signed-in person to /join?token=… enrolled them
// in the inviting family without a click: their name went to that family and
// its notifications to their phone. The page now shows who is inviting them
// and as what (previewInviteAction, only to the address the invite names) and
// accepts only when "Accept invitation" is pressed.
//
// Driven through the real component and the real server actions, against the
// in-memory database, with accept_invite modelled on 0136's own checks.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const nav = vi.hoisted(() => ({ token: 'tok-live', push: vi.fn(), refresh: vi.fn() }));
const faults = vi.hoisted(() => ({ client: null as null | { name: string; status?: number; code?: string; message: string }, server: null as null | { name: string; status?: number; code?: string; message: string }, serviceReads: vi.fn() }));
const who = vi.hoisted(() => ({ user: { id: 'u-sam', email: 'sam@example.test' } as { id: string; email: string } | null }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  useSearchParams: () => ({ get: (key: string) => (key === 'token' ? nav.token : null) }),
}));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', () => ({ LoadingBlock: () => null }));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  const { translate } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/app/(auth)/actions', () => ({ resolveLandingPathAction: async () => '/home' }));
vi.mock('@/lib/supabase/server', () => {
  const client = () => {
    const db = h.db as InMemorySupabase;
    return new Proxy(db, { get: (target, key) => (key === 'auth'
      ? { getUser: async () => ({ data: { user: who.user }, error: faults.server }) }
      : Reflect.get(target, key)) });
  };
  return { createServer: async () => client(), createServiceClient: () => { faults.serviceReads(); return client(); } };
});
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const db = h.db as InMemorySupabase;
    return { auth: { getUser: async () => ({ data: { user: who.user }, error: faults.client }) }, rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args) };
  },
}));

const { JoinInvite } = await import('@/components/auth/join-invite');
const FAMILY = 'fam-rivera';
let db: InMemorySupabase;
let accepts: string[];

function acceptInvite(args: Record<string, unknown>, mem: InMemorySupabase) {
  accepts.push(String(args.p_token));
  const row = mem.table('invites').find((i) => i.token === args.p_token);
  if (!row || row.status !== 'pending') throw new Error('Invite is invalid or expired');
  if (String(row.email).toLowerCase() !== who.user!.email.toLowerCase()) throw new Error('This invite was issued to a different email');
  mem.table('family_members').push({ id: 'm-sam', family_id: row.family_id, user_id: who.user!.id, role: row.role, is_active: true });
  Object.assign(row, { status: 'accepted', accepted_by: who.user!.id });
  return row.family_id;
}

const screen = () => render(h.hooks, createElement(JoinInvite));
async function mounted() {
  screen();
  await settle();
  await settle();
  return screen();
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  accepts = [];
  nav.token = 'tok-live';
  who.user = { id: 'u-sam', email: 'sam@example.test' };
  db = createInMemorySupabase({ rpc: { accept_invite: acceptInvite } });
  h.db = db;
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  db.seed('families', [{ id: FAMILY, name: 'The Riveras' }]);
  db.seed('invites', [
    { id: 'i-live', family_id: FAMILY, email: 'Sam@Example.test', role: 'caregiver', token: 'tok-live', status: 'pending', expires_at: soon },
    { id: 'i-dupe', family_id: FAMILY, email: 'sam@example.test', role: 'adult', token: 'tok-dupe', status: 'pending', expires_at: soon },
    { id: 'i-theirs', family_id: FAMILY, email: 'someone@example.test', role: 'adult', token: 'tok-theirs', status: 'pending', expires_at: soon },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the join page asks before it accepts', () => {
  it('opening the link accepts nothing; it names the family and the role and waits for a click', async () => {
    const tree = await mounted();
    expect(accepts).toEqual([]);
    expect(db.table('family_members')).toEqual([]);
    expect(has(tree, 'You’re invited to join The Riveras as Caregiver.')).toBe(true);
    expect(byName(tree, 'Accept invitation')).toBeTruthy();
  });

  it('"Accept invitation" joins, and closes the other invite to the same address', async () => {
    const tree = await mounted();
    await click(byName(tree, 'Accept invitation'));
    await settle();
    expect(accepts).toEqual(['tok-live']);
    expect(db.table('family_members')).toEqual([expect.objectContaining({ family_id: FAMILY, user_id: 'u-sam', is_active: true })]);
    expect(db.table('invites').find((i) => i.id === 'i-dupe')!.status).toBe('expired');
    expect(db.table('invites').find((i) => i.id === 'i-theirs')!.status).toBe('pending');
    expect(has(screen(), 'Welcome to the family!')).toBe(true);
  });

  it('an invite to another address says so before anything is asked of the database, and shows no family', async () => {
    who.user = { id: 'u-kim', email: 'kim@example.test' };
    const tree = await mounted();
    expect(accepts).toEqual([]);
    expect(has(tree, 'This invite was sent to a different email address. Sign in with that address to join.')).toBe(true);
    expect(has(tree, 'The Riveras')).toBe(false);
  });

  it('a revoked invite is refused up front', async () => {
    db.table('invites').find((i) => i.id === 'i-live')!.status = 'revoked';
    const tree = await mounted();
    expect(accepts).toEqual([]);
    expect(has(tree, 'This invite is invalid or has expired. Ask whoever invited you to send a new one.')).toBe(true);
  });
});

// Literal returned-error records; no SDK implementation or fault injection runs.
beforeEach(() => { faults.client = null; faults.server = null; faults.serviceReads.mockClear(); });
const { previewInviteAction } = await import('@/app/join/actions');
const unavailableRead = () => ({ name: 'AuthRetryableFetchError', status: 503, message: 'Synthetic unavailable auth read' });
describe('uncertain auth reads do not decide that the invitee signed out', () => {
  for (const staleUser of [false, true]) {
    it('client returned 503 with ' + (staleUser ? 'stale user' : 'no user') + ' shows retry copy without protected reads', async () => {
      if (!staleUser) who.user = null;
      faults.client = unavailableRead();
      const tree = await mounted();
      expect(has(tree, 'We couldn’t add you to the family just now. Check your connection and try again.')).toBe(true);
      expect(has(tree, 'Sign in')).toBe(false);
      expect(has(tree, 'The Riveras')).toBe(false);
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
      expect(db.table('family_members')).toEqual([]);
      expect(db.table('invites').every(i => i.status === 'pending')).toBe(true);
    });
    it('server returned 503 with ' + (staleUser ? 'stale user' : 'no user') + ' refuses preview before service access', async () => {
      if (!staleUser) who.user = null;
      faults.server = unavailableRead();
      expect(await previewInviteAction('tok-live')).toEqual({ ok: false, reason: 'unavailable' });
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
      expect(db.table('family_members')).toEqual([]);
      expect(db.table('invites').every(i => i.status === 'pending')).toBe(true);
    });
  }
  it('a confirmed anonymous client still offers sign in without protected reads', async () => {
    who.user = null;
    const tree = await mounted();
    expect(has(tree, 'Sign in')).toBe(true);
    expect(has(tree, 'The Riveras')).toBe(false);
    expect(faults.serviceReads).not.toHaveBeenCalled();
    expect(accepts).toEqual([]);
  });
  it('a confirmed anonymous server still returns signed out before service access', async () => {
    who.user = null;
    expect(await previewInviteAction('tok-live')).toEqual({ ok: false, reason: 'signed_out' });
    expect(faults.serviceReads).not.toHaveBeenCalled();
  });
});

describe('confirmed returned credential rejection stays signed out', () => {
  for (const status of [401, 403]) {
    it('client rejection ' + status + ' ignores stale user and permits no protected read', async () => {
      faults.client = { name: 'AuthApiError', status, message: 'Credential rejected' };
      const tree = await mounted();
      expect(has(tree, 'Sign in')).toBe(true);
      expect(has(tree, 'The Riveras')).toBe(false);
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
    });
    it('server rejection ' + status + ' ignores stale user and permits no protected read', async () => {
      faults.server = { name: 'AuthApiError', status, message: 'Credential rejected' };
      expect(await previewInviteAction('tok-live')).toEqual({ ok: false, reason: 'signed_out' });
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
    });
  }
});

// Same accepted invite consumers, now with the literal unknown-wrapper shape.
// No SDK constructor, refresh request, stored session or fault-loop is involved.
const unknownRead = () => ({ name: 'AuthUnknownError', __isAuthError: true,
  status: undefined, code: undefined, message: 'Unexpected end of JSON input',
  originalError: { name: 'SyntaxError', message: 'Unexpected end of JSON input' } });

describe('the invite consumers keep unknown returned auth reads unavailable', () => {
  for (const staleUser of [false, true]) {
    it('client unknown read with ' + (staleUser ? 'stale user' : 'no user') + ' cannot become sign-in', async () => {
      if (!staleUser) who.user = null;
      faults.client = unknownRead();
      const tree = await mounted();
      expect(has(tree, 'We couldn’t add you to the family just now. Check your connection and try again.')).toBe(true);
      expect(has(tree, 'Sign in')).toBe(false);
      expect(has(tree, 'The Riveras')).toBe(false);
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
      expect(db.table('family_members')).toEqual([]);
      expect(db.table('invites').every(i => i.status === 'pending')).toBe(true);
    });
    it('server unknown read with ' + (staleUser ? 'stale user' : 'no user') + ' cannot become signed out', async () => {
      if (!staleUser) who.user = null;
      faults.server = unknownRead();
      expect(await previewInviteAction('tok-live')).toEqual({ ok: false, reason: 'unavailable' });
      if (staleUser) {
        // The browser check succeeds; the actual preview action carries the
        // unknown read outcome back through the real component's UI branch.
        const tree = await mounted();
        expect(has(tree, 'We couldn’t add you to the family just now. Check your connection and try again.')).toBe(true);
        expect(has(tree, 'Sign in')).toBe(false);
        expect(has(tree, 'The Riveras')).toBe(false);
      }
      expect(faults.serviceReads).not.toHaveBeenCalled();
      expect(accepts).toEqual([]);
      expect(db.table('family_members')).toEqual([]);
      expect(db.table('invites').every(i => i.status === 'pending')).toBe(true);
    });
  }
});
