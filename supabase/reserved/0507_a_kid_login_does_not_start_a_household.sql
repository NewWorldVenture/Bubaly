-- 0507 — A kid login does not start a household.
-- Found by Support (#771 comment 6100987720, left for the owner); claimed and
-- measured in 6101311405.
--
-- families_insert is `with check (created_by = auth.uid())`, and on_family_created
-- files the creator as the new household's parent. A kid login is an ordinary
-- authenticated session, so it can create a household of its own and manage
-- it. Measured on a replay of every runnable migration, and again with every
-- held migration through 0506 applied, as a kid login that is a child in Real
-- Home, under PostgREST's role:
--
--   insert a family with created_by = itself          OK 1   (filed as parent)
--   as that parent, invite a stranger's address, adult  OK 1
--   the stranger accepts                                 joined; reads the kid
--   Real Home's parent reads that household              0
--
-- That is the harm 0495's second rule closes at accept_invite (a child enrolled
-- in a stranger's household, where its adults can message them and its own
-- parents cannot see it), reached through family creation instead. 0495's
-- header: "There is no designed flow for a kid login to belong to a second
-- household; if the owner wants one … it should be a parent-to-parent action,
-- not a child's click." Writing a login onto a member row is already refused
-- ("A login joins a family through an invitation, not by being written onto a
-- member."), so creating a household was the remaining door.
--
-- This adds a BEFORE INSERT guard on families. A signed-in caller whose own
-- account is a kid login is refused (42501, its own sentence). The account is
-- read exactly as 0495 reads it, from auth.users, which only the server writes:
-- its address is on the synthetic kid domain, or its app_metadata carries
-- `bubaly_kid_login: true` (createChildLoginAction sets both with the service
-- role). user_metadata is not read: its owner can edit it. SECURITY DEFINER so
-- it can read auth.users; search_path pinned.
--
-- The service role and session-less writers are exempt, as in every guard of
-- this family, and everyone else creates a household exactly as before. The
-- onboarding wizard's own refusal (Support, 6100987720 item 2) stays the
-- app-side message; this is the database's.
--
-- Not changed, recorded: households a kid login has already created are left
-- as they are (production data). A kid login whose address was moved off the
-- domain before createChildLoginAction set the app_metadata mark is not
-- recognised (0495's residual, and its PIN sign-in no longer works either).
--
-- HELD: 0507, the first number above 0506, requested on #771 in comment
-- 6101311405 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-kid-login-does-not-start-a-household-check.sql and
-- .github/workflows/kid-household-runtime.yml. Not applied to production by an
-- agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.families') is null then
    raise exception '0507 needs public.families';
  end if;
  if to_regclass('auth.users') is null then
    raise exception '0507 needs auth.users';
  end if;
end
$$;

create or replace function public.family_is_not_a_kid_logins_to_start()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The trusted server (service role, or a migration/seed with no session).
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null then
    return new;
  end if;
  -- A kid login, read from the account, as 0495 reads it.
  if exists (select 1
               from auth.users u
              where u.id = auth.uid()
                and (right(lower(coalesce(u.email, '')), length('@kids.bubaly.app')) = '@kids.bubaly.app'
                     or coalesce(u.raw_app_meta_data->>'bubaly_kid_login', '') = 'true')) then
    raise exception 'A kid login cannot start a family of its own'
      using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.family_is_not_a_kid_logins_to_start() is
  'Refuses (42501) a signed-in kid login creating a family, which on_family_created would make it the parent of (0507). A kid login is read from auth.users as 0495 reads it: the synthetic kid domain or app_metadata.bubaly_kid_login. The service role and session-less writers are unaffected.';

revoke all on function public.family_is_not_a_kid_logins_to_start() from public;

drop trigger if exists trg_family_is_not_a_kid_logins_to_start on public.families;
create trigger trg_family_is_not_a_kid_logins_to_start
  before insert on public.families
  for each row execute function public.family_is_not_a_kid_logins_to_start();

do $$
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.families'::regclass
                    and t.tgname = 'trg_family_is_not_a_kid_logins_to_start'
                    and t.tgfoid = 'public.family_is_not_a_kid_logins_to_start()'::regprocedure
                    and t.tgenabled <> 'D'
                    and (t.tgtype & 2) = 2      -- BEFORE
                    and (t.tgtype & 1) = 1      -- ROW
                    and (t.tgtype & 4) = 4) then -- INSERT
    raise exception '0507: families does not carry the enabled BEFORE INSERT row guard';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.family_is_not_a_kid_logins_to_start()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0507: the guard is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
