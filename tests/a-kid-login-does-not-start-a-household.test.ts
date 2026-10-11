import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

// The held 0507 makes 0482's is_child_login_account() also read the kid-login
// mark the server writes, so a kid login whose address moved off the synthetic
// domain cannot start a household it would be the parent of. It must keep
// recognising every account 0482 does, read the mark exactly as 0495's
// accept_invite does, and read the domain and the mark the app actually mints.

const G0507 = 'supabase/reserved/0507_a_kid_login_does_not_start_a_household.sql';
const G0482 = 'supabase/migrations/0482_who_may_make_unmake_and_invite_a_parent.sql';
const G0495 = 'supabase/reserved/0495_a_member_invited_back_gets_what_the_invite_grants.sql';
const ACTIONS = 'app/(app)/family/child-login-actions.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');

/** The body of `create or replace function public.is_child_login_account()` up to its closing `$$;`. */
function body(sql: string): string {
  const m = /create or replace function public\.is_child_login_account\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/.exec(sql);
  expect(m, 'no is_child_login_account() body').not.toBeNull();
  return squash(m![1]).trim();
}

describe('a kid login does not start a household', () => {
  const mine = body(read(G0507));
  const released = body(read(G0482));

  it("keeps every test 0482's function makes", () => {
    expect(released).toContain('exists (select 1 from public.child_logins c where c.user_id = auth.uid())');
    expect(mine).toContain('exists (select 1 from public.child_logins c where c.user_id = auth.uid())');
    expect(released).toContain("lower(u.email) like '%@kids.bubaly.app'");
    expect(mine).toContain("lower(u.email) like '%@kids.bubaly.app'");
    expect(mine.startsWith('select auth.uid() is not null and (')).toBe(true);
  });

  it("adds the mark, read exactly as 0495's accept_invite reads it and as the server writes it", () => {
    const mark = "coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'";
    expect(mine).toContain(mark);
    expect(released).not.toContain('bubaly_kid_login');
    expect(squash(read(G0495))).toContain(mark);
    expect(/const KID_LOGIN_APP_METADATA_KEY = '([^']+)'/.exec(read(ACTIONS))?.[1]).toBe('bubaly_kid_login');
    // user_metadata is the account owner's to edit, so it is never read.
    expect(mine).not.toMatch(/raw_user_meta_data/);
  });

  it('reads the domain the app mints kid addresses on', () => {
    expect(mine).toContain(`@${CHILD_LOGIN_EMAIL_DOMAIN}'`);
  });

  it("keeps 0482's definer, search path and grants, and checks families_insert still asks", () => {
    const sql = squash(read(G0507));
    expect(sql).toContain('stable security definer set search_path = pg_catalog, public, pg_temp as $$');
    expect(sql).toContain('revoke all on function public.is_child_login_account() from public, anon;');
    expect(sql).toContain('grant execute on function public.is_child_login_account() to authenticated, service_role;');
    expect(sql).toContain("p.with_check ~ 'NOT is_child_login_account\\(\\)'");
    expect(squash(read(G0482))).toContain('with check (created_by = auth.uid() and not public.is_child_login_account());');
  });
});
