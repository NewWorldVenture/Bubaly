// A username and a 4-digit PIN are a child's sign-in, never a manager's.
//
// `resetChildPinAction` refuses a parent or adult outright, and its comment
// gives the reason the create half did not need the same rule: "a manager
// always has [a user_id]", and `createChildLoginAction` refuses a member who
// already has one. That premise is false. A member added without an email,
// such as a grandparent, a co-parent placeholder or a member onboarding
// created, has `user_id = null` whatever its role. `/dashboard/family-access`
// offered every such member a "kid login", and the action minted one: a new
// auth account signed in by four digits, holding the parent's or adult's role.
// That is every manager power (money, the vault, other members) behind a PIN,
// and a login whose PIN can then never be reset, because the reset refuses it.
//
// These call the real action and assert what reaches the auth admin API,
// because "the source reads the role" is not the claim; "no PIN account is
// created for a manager" is. The page half is checked the same way: the props
// it hands the manager component.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const PARENT_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NEW_USER = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  member: null as Row | null,
  roster: [] as Row[],
  logins: [] as Row[],
  created: [] as string[],
  appMetadata: [] as unknown[],
  memberWrites: [] as Row[],
  accessProps: null as Row | null,
}));

/** A service client whose member read is configurable and whose writes are observed. */
function fakeAdmin() {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    let payload: Row | null = null;
    const resolve = () => Promise.resolve({
      data: name === 'family_members' && payload === null ? state.member : payload ? [{ id: TARGET_MEMBER }] : null,
      error: null,
    });
    // `is` too: the member link is a compare-and-set on `user_id IS NULL`.
    for (const method of ['select', 'eq', 'is', 'insert', 'upsert', 'delete']) chain[method] = () => chain;
    chain.update = (values: Row) => {
      payload = values;
      if (name === 'family_members') state.memberWrites.push(values);
      return chain;
    };
    chain.maybeSingle = resolve;
    chain.single = resolve;
    chain.limit = () => Promise.resolve({ data: [], error: null });
    chain.then = (...args: unknown[]) => (resolve() as PromiseLike<unknown>).then(...(args as [never, never]));
    return chain;
  };
  return {
    from: (name: string) => table(name),
    auth: {
      admin: {
        createUser: async ({ email, app_metadata }: { email: string; app_metadata?: unknown }) => {
          state.created.push(email);
          state.appMetadata.push(app_metadata);
          return { data: { user: { id: NEW_USER } }, error: null };
        },
        deleteUser: async () => ({ data: null, error: null }),
      },
    },
  };
}

/** The session client the page reads the roster and existing logins through. */
function fakeServer() {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const result = () => ({ data: name === 'family_members' ? state.roster : state.logins, error: null });
    for (const method of ['select', 'eq', 'order']) chain[method] = () => chain;
    chain.then = (...args: unknown[]) => Promise.resolve(result()).then(...(args as [never, never]));
    return chain;
  };
  return { from: (name: string) => table(name) };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT_USER },
    active: { familyId: FAMILY, member: { id: PARENT_MEMBER }, role: 'parent' },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => fakeAdmin(),
  createServer: async () => fakeServer(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock('@/components/family/child-access-manager', () => ({
  ChildAccessManager: (props: Row) => { state.accessProps = props; return null; },
}));

process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';

const { createChildLoginAction } = await import('@/app/(app)/family/child-login-actions');
const { default: FamilyAccessPage } = await import('@/app/(app)/dashboard/family-access/page');

const placeholder = (role: string): Row => ({
  id: TARGET_MEMBER, family_id: FAMILY, display_name: 'Placeholder', role, user_id: null,
});

beforeEach(() => {
  state.member = null;
  state.roster = [];
  state.logins = [];
  state.created = [];
  state.appMetadata = [];
  state.memberWrites = [];
  state.accessProps = null;
});

describe('createChildLoginAction makes a PIN login only for a member who is not a manager', () => {
  // The negative control, first: a child's login still has to be created, or
  // every refusal below is satisfied by an action that does nothing.
  it('creates a login for a child with no login yet', async () => {
    state.member = placeholder('child');
    const result = await createChildLoginAction({ memberId: TARGET_MEMBER, username: 'jordan', pin: '1234' });
    expect(result).toEqual({ ok: true, data: { username: 'jordan' } });
    expect(state.created).toHaveLength(1);
    expect(state.memberWrites).toContainEqual({ user_id: NEW_USER, is_active: true });
    // The server-owned mark of a kid login (app_metadata, which only the
    // service role can write); the held 0495 reads it if the address changes.
    expect(state.appMetadata).toEqual([{ bubaly_kid_login: true }]);
  });

  it.each(['teen', 'caregiver', 'guest'])('still creates one for a %s, who manages nothing', async (role) => {
    state.member = placeholder(role);
    const result = await createChildLoginAction({ memberId: TARGET_MEMBER, username: 'jordan', pin: '1234' });
    expect(result.ok).toBe(true);
    expect(state.created).toHaveLength(1);
  });

  it.each(['parent', 'adult'])('refuses a %s placeholder before any account exists', async (role) => {
    state.member = placeholder(role);
    const result = await createChildLoginAction({ memberId: TARGET_MEMBER, username: 'jordan', pin: '1234' });
    // The account first: against the pre-fix action this reports the synthetic
    // email of the manager's new PIN login, which is the defect itself.
    expect(state.created).toEqual([]);
    expect(state.memberWrites).toEqual([]);
    expect(result).toEqual({ ok: false, error: 'childLoginActions.aParentOrAdultSignsIn' });
  });
});

/** The props the page hands the manager component, read from its returned tree. */
function accessMembers(tree: ReactNode): Row[] {
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isValidElement(node)) return;
    const element = node as ReactElement<Row & { children?: ReactNode }>;
    if (typeof element.type === 'function' && 'members' in element.props) {
      (element.type as (props: Row) => unknown)(element.props);
      return;
    }
    visit(element.props.children);
  };
  visit(tree);
  if (!state.accessProps) throw new Error('the page rendered no ChildAccessManager');
  return state.accessProps.members as Row[];
}

describe('/dashboard/family-access offers a kid login only where one may be made', () => {
  it('lists children without a login and existing logins, never a manager without one', async () => {
    state.roster = [
      { id: 'm-child', display_name: 'Kid', role: 'child', color: null, user_id: null },
      { id: 'm-teen', display_name: 'Teen', role: 'teen', color: null, user_id: null },
      { id: 'm-grandma', display_name: 'Grandma', role: 'adult', color: null, user_id: null },
      { id: 'm-coparent', display_name: 'Co-parent', role: 'parent', color: null, user_id: null },
      { id: 'm-self', display_name: 'Me', role: 'parent', color: null, user_id: PARENT_USER },
      { id: 'm-kid-login', display_name: 'Has login', role: 'child', color: null, user_id: NEW_USER },
    ];
    state.logins = [{ member_id: 'm-kid-login', username: 'haslogin' }];
    const members = accessMembers(await FamilyAccessPage());
    expect(members.map((m) => m.id)).toEqual(['m-child', 'm-teen', 'm-kid-login']);
    expect(members.find((m) => m.id === 'm-kid-login')?.username).toBe('haslogin');
  });
});
