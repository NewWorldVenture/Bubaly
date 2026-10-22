-- 0507 — A kid login does not start a household: 0482's test also reads the
-- server's kid-login mark.
-- Found by Support (#771 comment 6100987720, left for the owner); claimed and
-- measured in 6101311405; recut on main through 0485 (#989).
--
-- families_insert checks created_by = auth.uid(), and on_family_created files
-- the creator as the new household's parent, so a kid login that starts a
-- household becomes its parent, invites a stranger in, and is reached there
-- where its own parents cannot see: the harm 0495 closes at accept_invite.
-- 0482 (released) closed most of it: families_insert now also requires
-- `not is_child_login_account()`, which is true for an account with a
-- child_logins row or an address on the synthetic kid domain.
--
-- It does not read the third mark the server writes. createChildLoginAction
-- sets app_metadata.bubaly_kid_login = true with the service role, and 0495's
-- accept_invite recognises a kid login by the domain OR that mark, so a kid
-- login stays recognised if its address is ever moved off the domain. Measured
-- on a replay of every runnable migration through 0485, as a kid login known
-- only by that mark (its address moved off the domain, no child_logins row):
--
--   insert a family with created_by = itself          OK 1   (filed as parent)
--   as that parent, invite a stranger, adult            OK 1
--
-- while a kid login on the domain, or with a child_logins row, is refused.
--
-- This replaces is_child_login_account() with 0482's body plus that one test,
-- read from auth.users exactly as 0495 reads it (raw_app_meta_data, which only
-- the service role writes; user_metadata is the account's own and is not
-- read). Everything that asks the function, families_insert today, then
-- recognises the same accounts accept_invite does. Its grants are 0482's.
--
-- Not changed, recorded as limits (the owner's or other lanes' to close):
--   * the server's own provisioning. ensureActiveFamily (lib/server/
--     ensure-family.ts) provisions a household for an account with no active
--     membership through the service role, which RLS does not bind. It
--     refuses a child login it recognises by a child_logins row or
--     user_metadata.child (lib/server/child-account.ts, the membership lane's
--     repair; #771 6088720897, 6092045838, 6094677336, 6100987720), not by
--     this mark or the domain. Closing that end to end is that lane's, and an
--     orphaned or removed kid's provisioning test belongs with it.
--   * households a kid login already created are left as they are
--     (production data), and a kid login made before the mark existed, whose
--     address was later moved off the domain and whose mapping is gone, is not
--     recognised by any test (0495's residual).
--
-- HELD: 0507, the first number above 0506, requested on #771 in comment
-- 6101311405 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-kid-login-does-not-start-a-household-check.sql and
-- .github/workflows/kid-household-runtime.yml. Not applied to production by an
-- agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regprocedure('public.is_child_login_account()') is null then
    raise exception '0507 needs is_child_login_account() from 0482';
  end if;
  if to_regclass('public.child_logins') is null or to_regclass('auth.users') is null then
    raise exception '0507 needs public.child_logins and auth.users';
  end if;
end
$$;

create or replace function public.is_child_login_account()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select auth.uid() is not null and (
    exists (select 1 from public.child_logins c where c.user_id = auth.uid())
    or exists (select 1 from auth.users u
                where u.id = auth.uid()
                  and (lower(u.email) like '%@kids.bubaly.app'
                       or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true'))
  )
$$;

comment on function public.is_child_login_account() is
  '0482, widened by 0507: true when the caller is a child-login auth user (a child_logins row, the synthetic @kids.bubaly.app address, or the bubaly_kid_login mark in app_metadata that only the server writes). Answers only about the caller.';

revoke all on function public.is_child_login_account() from public, anon;
grant execute on function public.is_child_login_account() to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.is_child_login_account()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')
                    and f.prosrc ~ 'child_logins'
                    and f.prosrc ~ '@kids\.bubaly\.app'
                    and f.prosrc ~ 'raw_app_meta_data->>''bubaly_kid_login''') then
    raise exception '0507: is_child_login_account is not the SECURITY DEFINER test of all three marks';
  end if;
  if not exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = 'families'
                    and p.policyname = 'families_insert' and p.cmd = 'INSERT'
                    and p.with_check ~ 'NOT is_child_login_account\(\)') then
    raise exception '0507: families_insert no longer asks is_child_login_account(), so this changes nothing there';
  end if;
end
$$;
