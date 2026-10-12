-- 0512 — A kid login is never a parent or adult.
-- Decided by the account holder this session ("refuse until the PIN login is
-- gone"), recorded and requested on #771 in comment 6104294318.
--
-- A kid login is a username and a 4-digit PIN: the server derives the
-- account's password from them (lib/onboarding/child-password.ts). #981 stops
-- the app creating one on a parent's or adult's member row, because a PIN must
-- not be all that stands in front of an account that reaches the household's
-- money, its vault and every other member. The other order was open: a child
-- who has a PIN login is promoted to adult or parent in the member editor
-- (family-module.tsx's update of `role`), and the PIN login stays, now
-- guarding a manager. Measured on a replay through 0485, as the household's
-- parent through PostgREST's role: `update family_members set role = 'adult'`
-- on a child with a `child_logins` row returned UPDATE 1, and the child's
-- session then passed can_manage_family.
--
-- This makes the rule the database's, from both sides:
--
--   * family_members: a row is refused `parent` or `adult` when its account
--     is a kid login, as the account itself says and only the server writes:
--     its address is on the synthetic kid domain (the only address the PIN
--     sign-in reaches), or its app_metadata carries the `bubaly_kid_login`
--     mark. Only when the role or the login changes, or on insert: editing the
--     name of a row that is already so is not refused, and nothing already
--     stored is changed.
--
--     Not child_logins, for 0495's reason: a household's parent can write a
--     mapping (0297) for any account, so trusting it would let one household
--     keep another's adult from being an adult anywhere. A mapping onto a real
--     account gives no PIN access to it either: the PIN signs in at the
--     synthetic address.
--   * child_logins: a mapping is refused for a member who is a parent or
--     adult, or for an account that is a parent or adult in any family. The
--     app already refuses the first (createChildLoginAction); this is the same
--     rule where the service role writes.
--
-- A kid login is an account, so the rule is the account's in every family: a
-- PIN guards whatever that account can reach. Two functions, one per table,
-- so each body reads only its own table's columns.
--
-- Both refuse with 42501 and a sentence that says what to do. Every caller is
-- held to it, the service role included: there is no path on which a kid
-- login is meant to become a manager.
--
-- Shipped with the source: the member editor does not offer adult or parent
-- for a member with a kid login and says why, and the kid access manager
-- gains "Remove kid login" (removeChildLoginAction: the mapping, the link and
-- the PIN account go, through the same steps as a failed create's rollback),
-- so a parent can do what the refusal asks.
--
-- HELD: 0512, the first number above 0511, requested on #771 in comment
-- 6104294318 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-kid-login-is-never-a-parent-or-adult-check.sql and
-- .github/workflows/kid-login-manager-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.child_logins') is null or to_regclass('public.family_members') is null then
    raise exception '0512 needs public.child_logins and public.family_members';
  end if;
end
$$;

create or replace function public.a_kid_login_is_never_a_manager()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if new.role in ('parent', 'adult')
     and (tg_op = 'INSERT' or new.role is distinct from old.role or new.user_id is distinct from old.user_id)
     and new.user_id is not null
     and exists (select 1 from auth.users u
                  where u.id = new.user_id
                    and (lower(coalesce(u.email, '')) like '%@kids.bubaly.app'
                         or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true')) then
    raise exception using
      errcode = '42501',
      message = 'A member who signs in with a kid PIN cannot be a parent or adult. Remove their kid login first.';
  end if;
  return new;
end
$fn$;

comment on function public.a_kid_login_is_never_a_manager() is
  'Refuses a parent or adult role for a member whose account is a kid login (synthetic address or the server''s mark), in any family (0512).';

create or replace function public.a_manager_is_never_a_kid_login()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if exists (select 1 from public.family_members m where m.id = new.member_id and m.role in ('parent', 'adult'))
     or exists (select 1 from public.family_members m where m.user_id = new.user_id and m.role in ('parent', 'adult')) then
    raise exception using
      errcode = '42501',
      message = 'A parent or adult signs in with their own email, not a kid PIN.';
  end if;
  return new;
end
$fn$;

comment on function public.a_manager_is_never_a_kid_login() is
  'Refuses a kid login for a parent or adult member, or for an account that is a parent or adult in any family (0512).';

revoke all on function public.a_kid_login_is_never_a_manager() from public;
revoke all on function public.a_kid_login_is_never_a_manager() from anon;
revoke all on function public.a_kid_login_is_never_a_manager() from authenticated;
revoke all on function public.a_manager_is_never_a_kid_login() from public;
revoke all on function public.a_manager_is_never_a_kid_login() from anon;
revoke all on function public.a_manager_is_never_a_kid_login() from authenticated;

drop trigger if exists a_kid_login_is_never_a_manager on public.family_members;
create trigger a_kid_login_is_never_a_manager
  before insert or update of role, user_id on public.family_members
  for each row execute function public.a_kid_login_is_never_a_manager();

drop trigger if exists a_manager_is_never_a_kid_login on public.child_logins;
create trigger a_manager_is_never_a_kid_login
  before insert or update of member_id, user_id on public.child_logins
  for each row execute function public.a_manager_is_never_a_kid_login();

do $$
begin
  if not exists (select 1 from pg_trigger t where t.tgname = 'a_kid_login_is_never_a_manager' and not t.tgisinternal
                    and t.tgenabled = 'O' and t.tgrelid = 'public.family_members'::regclass)
     or not exists (select 1 from pg_trigger t where t.tgname = 'a_manager_is_never_a_kid_login' and not t.tgisinternal
                    and t.tgenabled = 'O' and t.tgrelid = 'public.child_logins'::regclass) then
    raise exception '0512: the guard is not enabled on both tables';
  end if;
  if (select count(*) from pg_proc f
       where f.oid in ('public.a_kid_login_is_never_a_manager()'::regprocedure, 'public.a_manager_is_never_a_kid_login()'::regprocedure)
         and f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) <> 2 then
    raise exception '0512: the guards are not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
