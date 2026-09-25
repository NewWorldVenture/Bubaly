import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SEC-026. fm_insert, fm_update and fm_delete gate on can_manage_family, which
// is true for adults, and none limits `role`. An invited adult could make
// themselves a parent — and then pass is_family_admin, the whole of
// families_delete — or demote, deactivate or delete the family's parent. The
// family module offered it: Edit/Remove on every card for any manager, with
// Parent in the role picker.
//
// docs/audit/parent-role-is-the-parents-check.sql proves the behaviour on a
// real catalogue (7 breaches before 0337, none after, with adults still
// managing everyone else). This pins what that probe cannot see: the trigger
// runs as the caller (a definer trigger's current_user is the owner, which
// would exempt everybody), and the screen stops offering what is refused.

const MIG = 'supabase/migrations/0337_only_a_parent_makes_or_changes_a_parent.sql';
const executable = (raw: string) => raw.replace(/^\s*--.*$/gm, '');
const sql = executable(readFileSync(MIG, 'utf8'));
const body = sql.slice(sql.indexOf('function public.family_parent_role_is_the_parents()'), sql.indexOf('$$;'));
const familyModule = readFileSync('components/modules/family-module.tsx', 'utf8');

describe('only a parent makes, changes or removes a parent (0337)', () => {
  it('fires on every write to a member row', () => {
    expect(sql).toMatch(/create trigger trg_family_parent_role_is_the_parents\s+before insert or update or delete on public\.family_members\s+for each row/);
  });

  it('runs as the caller and exempts only the server and definer functions', () => {
    expect(body).not.toMatch(/security\s+definer/i);
    expect(body).toMatch(/if current_user not in \('authenticated', 'anon'\) then/);
  });

  it('refuses a non-parent removing, changing or making a parent', () => {
    expect(body).toMatch(/tg_op = 'DELETE'[\s\S]*old\.role = 'parent' and not public\.is_family_admin\(old\.family_id\)/);
    expect(body).toMatch(/tg_op = 'UPDATE' and old\.role = 'parent' and not public\.is_family_admin\(old\.family_id\)/);
    expect(body).toMatch(/new\.role = 'parent' and \(tg_op = 'INSERT' or old\.role is distinct from 'parent'/);
    expect(body.match(/errcode = 'insufficient_privilege'/g)).toHaveLength(3);
  });

  it('lets a family with no active parent make one, so it is never stuck without one', () => {
    expect(body).toMatch(/m\.role = 'parent' and m\.is_active\s+and m\.id is distinct from new\.id/);
  });
});

describe('the family screen offers parent changes only to a parent', () => {
  it('hides Edit and Remove on a parent card from anyone who is not a parent', () => {
    expect(familyModule).toMatch(/canManage && !isLastManager\(m\) && \(isParent \|\| m\.role !== 'parent'\)/);
    expect(familyModule).toMatch(/\{canManageMember\(m\) && \(/);
  });

  it('leaves Parent out of the role picker unless the viewer may make one', () => {
    expect(familyModule).toMatch(/const canMakeParent = isParent \|\| !activeMembers\.some\(\(m\) => m\.role === 'parent'\)/);
    expect(familyModule).toMatch(/ROLE_OPTIONS\.filter\(\(r\) => r !== 'parent' \|\| canMakeParent\)/);
  });
});
