// ROLE-M03 (0464): the role a parent picks for an extended-family invite is
// described as view-only on the invite form (lib/constants/roles.ts), on
// /family/permissions (public.permissions) and in the trust engine — and an
// active guest could create, edit and delete the family's calendar, chores,
// documents, groceries, meals, notes and reminders. The behaviour is proved by
// docs/audit/a-guest-views-the-household-check.sql in CI's Database job, which
// requires the guest's measured access to equal the page's guest row; this
// pins the shape and the three descriptions the fix enforces.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_DESCRIPTIONS } from '@/lib/constants/roles';
import { ROLE_DEFAULTS } from '@/lib/trust/engine';

const migration = readFileSync('supabase/migrations/0464_a_guest_views_the_household.sql', 'utf8');
const RESOURCES = ['calendar_events', 'chore_assignments', 'chores', 'documents', 'grocery_items', 'meals', 'notes', 'reminders'];

describe('a guest views the household; it does not rewrite it (ROLE-M03)', () => {
  it('every model the product carries describes the guest as view-only', () => {
    expect(ROLE_DESCRIPTIONS.guest).toMatch(/^View /);
    expect(ROLE_DEFAULTS.guest.capabilities).toEqual(['view']);
  });

  it('guards exactly the eight resources /family/permissions shows', () => {
    const list = migration.match(/foreach t in array array\[([^\]]+)\]/)?.[1] ?? '';
    expect(list.match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)).sort()).toEqual([...RESOURCES].sort());
    expect(migration).toMatch(/create trigger %I before insert or update or delete on public\.%I '\s*'for each row execute function public\.household_write_is_not_a_guests\(\)'/);
  });

  it('refuses a guest loudly (42501) and nobody else', () => {
    const start = migration.indexOf('create or replace function public.household_write_is_not_a_guests()');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    expect(body).toMatch(/if auth\.uid\(\) is null then\s+return case when tg_op = 'DELETE' then old else new end; -- service role/);
    expect(body).toMatch(/\(tg_op <> 'INSERT' and public\.family_role\(old\.family_id\) = 'guest'\)\s+or \(tg_op <> 'DELETE' and public\.family_role\(new\.family_id\) = 'guest'\)/);
    expect(body).toContain("using errcode = '42501'");
    expect(body.match(/raise exception/g)).toHaveLength(1);
  });

  it('is a trigger, not a filtering policy, so no screen reports a refused write as saved', () => {
    expect(migration).not.toMatch(/create policy/i);
  });
});
