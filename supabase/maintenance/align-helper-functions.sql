-- Bubaly :: maintenance — align base helper functions
--
-- NOT a numbered migration (lives outside supabase/migrations so it never affects
-- migration ordering). Run once against any environment whose base RLS/utility
-- helper functions are incomplete — e.g. a production database bootstrapped from
-- an older bundle that predates one of these helpers.
--
-- Why this exists: a production DB was found missing public.is_family_admin while
-- its siblings existed under an older parameter name (`fid` vs `p_family_id`).
-- Migrations that *call* a missing helper fail with "function ... does not exist".
--
-- Design: idempotent + SAFE. Creates a helper ONLY if it is absent, and NEVER
-- redefines or renames an existing one — so the RLS policies that depend on these
-- functions are never dropped/disturbed. Touches no table data. Safe to re-run.
--
-- The parameter name (`fid`) is intentional: it is invisible to callers (the
-- migrations call these positionally) and avoids a destructive DROP ... CASCADE.

do $do$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_family_member') then
    execute $fn$
      create function public.is_family_member(fid uuid)
      returns boolean language sql security definer stable set search_path = public as $b$
        select exists (select 1 from public.family_members
          where family_id = fid and user_id = auth.uid() and is_active);
      $b$;
    $fn$;
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'can_manage_family') then
    execute $fn$
      create function public.can_manage_family(fid uuid)
      returns boolean language sql security definer stable set search_path = public as $b$
        select exists (select 1 from public.family_members
          where family_id = fid and user_id = auth.uid() and role in ('parent','adult') and is_active);
      $b$;
    $fn$;
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_family_admin') then
    execute $fn$
      create function public.is_family_admin(fid uuid)
      returns boolean language sql security definer stable set search_path = public as $b$
        select exists (select 1 from public.family_members
          where family_id = fid and user_id = auth.uid() and role = 'parent' and is_active);
      $b$;
    $fn$;
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'set_updated_at') then
    execute $fn$
      create function public.set_updated_at()
      returns trigger language plpgsql as $b$
        begin new.updated_at = now(); return new; end;
      $b$;
    $fn$;
  end if;
end
$do$;

-- Verification (returns the four helper names that now exist):
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and proname in ('is_family_member','can_manage_family','is_family_admin','set_updated_at')
-- order by proname;
