// A kid login is never a parent or adult (the held 0512, the owner's decision
// "refuse until the PIN login is gone"). The database refuses the promotion;
// the member editor does not offer it to a member with a kid login and says
// what to do; and the Kid Logins page can do it, through removeChildLoginAction,
// which touches nothing until the mapping, the member row and the account all
// say this is that member's kid login.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rolesForAKidLogin, ROLE_ORDER } from '@/lib/constants/roles';
import { bodyOf } from './helpers/source-order';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PARENT_USER = '22222222-2222-4222-8222-222222222222';
const MEMBER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown> | null;
const state = vi.hoisted(() => ({
  role: 'parent',
  childLogin: null as Row,
  member: null as Row,
  account: null as { email: string | null } | null,
  deleted: [] as string[],
  updated: [] as string[],
  usersDeleted: [] as string[],
}));

function fakeAdmin() {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    let writing = false;
    const resolve = () => Promise.resolve({
      data: writing ? [{ id: 'row' }] : name === 'child_logins' ? state.childLogin : name === 'family_members' ? state.member : null,
      error: null,
    });
    for (const method of ['select', 'eq', 'is', 'insert', 'upsert']) chain[method] = () => chain;
    chain.delete = () => { writing = true; state.deleted.push(name); return chain; };
    chain.update = () => { writing = true; state.updated.push(name); return chain; };
    chain.maybeSingle = resolve;
    chain.single = resolve;
    chain.then = (...args: unknown[]) => (resolve() as PromiseLike<unknown>).then(...(args as [never, never]));
    return chain;
  };
  return {
    from: (name: string) => table(name),
    auth: {
      admin: {
        getUserById: async (userId: string) => ({
          data: state.account ? { user: { id: userId, email: state.account.email } } : { user: null }, error: null,
        }),
        deleteUser: async (userId: string) => { state.usersDeleted.push(userId); return { data: null, error: null }; },
      },
    },
  };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT_USER },
    active: { familyId: FAMILY, member: { id: 'parent-member' }, role: state.role },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeAdmin() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

const { removeChildLoginAction } = await import('@/app/(app)/family/child-login-actions');
const read = (p: string) => readFileSync(p, 'utf8');

beforeEach(() => {
  state.role = 'parent';
  state.childLogin = { user_id: ACCOUNT, username: 'sam', family_id: FAMILY };
  state.member = { id: MEMBER, family_id: FAMILY, user_id: ACCOUNT };
  state.account = { email: 'child.sam@kids.bubaly.app' };
  state.deleted = []; state.updated = []; state.usersDeleted = [];
});

describe('removing a kid login', () => {
  it('removes the mapping, the link and the PIN account', async () => {
    expect(await removeChildLoginAction({ memberId: MEMBER })).toEqual({ ok: true });
    expect(state.deleted).toEqual(['child_logins']);
    expect(state.updated).toEqual(['family_members']);
    expect(state.usersDeleted).toEqual([ACCOUNT]);
  });

  it.each([
    ['a non-manager asks', () => { state.role = 'teen'; }],
    ['the mapping is another family\'s', () => { state.childLogin = { ...state.childLogin, family_id: 'other' }; }],
    ['the member row names another account', () => { state.member = { ...state.member, user_id: PARENT_USER }; }],
    ['the account is a real email, not this kid login', () => { state.account = { email: 'sam@example.com' }; }],
    ['the account is another kid login', () => { state.account = { email: 'child.ava@kids.bubaly.app' }; }],
  ])('touches nothing when %s', async (_label, arrange) => {
    arrange();
    const res = await removeChildLoginAction({ memberId: MEMBER });
    expect(res.ok).toBe(false);
    expect(state.deleted).toEqual([]);
    expect(state.updated).toEqual([]);
    expect(state.usersDeleted).toEqual([]);
  });
});

describe('the member editor', () => {
  it('never offers parent or adult to a member with a kid login, but keeps the role a row already has', () => {
    expect(rolesForAKidLogin(ROLE_ORDER, 'child')).toEqual(['teen', 'child', 'caregiver', 'guest']);
    expect(rolesForAKidLogin(ROLE_ORDER, 'adult')).toEqual(['adult', 'teen', 'child', 'caregiver', 'guest']);
  });

  it('asks whether the member has a kid login, narrows the roles and says why', () => {
    const src = read('components/modules/family-module.tsx');
    const modal = bodyOf(src, 'function MemberModal(', 'async function submit(');
    expect(modal).toContain("void settle(createClient().from('child_logins').select('id').eq('member_id', member.id).eq('family_id', familyId).limit(1))");
    expect(modal).toContain('const roleOptions = hasKidLogin ? rolesForAKidLogin(assignable, member?.role ?? null) : assignable;');
    expect(src).toContain("t('familyModule.aKidLoginCannotBeAManager', { name: member?.display_name ?? '' })");
  });

  it('the Kid Logins page offers the removal, with a confirmation', () => {
    const src = read('components/family/child-access-manager.tsx');
    const remove = bodyOf(src, 'async function remove()', '\n  }');
    expect(remove).toContain("confirm(t('childAccessManager.removeTheKidLoginConfirm'");
    expect(remove).toContain('await removeChildLoginAction({ memberId: member.id })');
  });

  it('says so in the seven base locales', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['familyModule.aKidLoginCannotBeAManager', 'childAccessManager.removeLogin', 'childAccessManager.removeLoginFor',
        'childAccessManager.removeTheKidLoginConfirm', 'childAccessManager.loginRemovedFor', 'childLoginActions.couldNotRemoveTheLogin']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
      expect(m['familyModule.aKidLoginCannotBeAManager'], locale).toContain(m['navLabel.kidLogins']);
    }
  });
});

describe('the database half', () => {
  it('refuses both orders, reads all three kid-login tests, and is pinned by the probe', () => {
    const sql = read('supabase/reserved/0512_a_kid_login_is_never_a_parent_or_adult.sql');
    expect(sql).toContain("before insert or update of role, user_id on public.family_members");
    expect(sql).toContain("before insert or update of member_id, user_id on public.child_logins");
    expect(sql).toContain("exists (select 1 from public.family_members m where m.user_id = new.user_id and m.role in ('parent', 'adult'))");
    // The account says what it is (0495's reason): never a mapping alone.
    const managerGuard = sql.slice(sql.indexOf('create or replace function public.a_kid_login_is_never_a_manager()'),
      sql.indexOf('create or replace function public.a_manager_is_never_a_kid_login()'));
    expect(managerGuard).not.toContain('public.child_logins');
    expect(managerGuard).toContain("like '%@kids.bubaly.app'");
    expect(sql).toContain("coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'");
    expect(sql).toContain("tg_op = 'INSERT' or new.role is distinct from old.role or new.user_id is distinct from old.user_id");
    const probe = read('docs/audit/reserved/a-kid-login-is-never-a-parent-or-adult-check.sql');
    expect(probe).toContain("$r$or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'$r$");
  });
});
