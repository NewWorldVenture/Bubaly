-- ── A-17 A restriction may not be removable by the person it restricts ───────
--
-- social_access_permissions OVERRIDES the social role a member would otherwise
-- get from their household role (lib/social/access.ts: "an explicit row wins").
-- The defaults are parent -> admin, adult -> marketing_manager,
-- teen -> content_creator, everyone else -> read_only, so an override is how a
-- parent holds someone BELOW their default.
--
-- 0034 required admin (or manage_access) to create or change such a row, but
-- allowed any family member to DELETE one — and deleting restores the higher
-- default. 0296 makes delete match. This proves it behaviourally, and proves it
-- can still see the old state.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/social-access-symmetry-check.sql

\set FS '00000000-0000-4000-8000-000000005a01'
\set UP '00000000-0000-4000-8000-000000005a02'
\set UA '00000000-0000-4000-8000-000000005a03'

-- Seed: one family, its parent, and an adult the parent has pinned to read_only.
insert into auth.users (id, email) values (:'UP','c-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UA','c-adult@example.com')  on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FS','Symmetry House',:'UP') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UP','Parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UA','Adult','adult',true) on conflict do nothing;
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
  values (:'FS',:'UA','read_only','active',:'UP') on conflict (family_id, user_id) do update set social_role = 'read_only';

grant select, insert, update, delete on public.social_access_permissions to authenticated;

-- ── Invariant: the restricted adult cannot delete their own restriction ──────
do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a03', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;

  perform set_config('role','postgres', true);
  if gone <> 0 then
    raise exception 'A-17 FAIL: a member deleted their own social restriction (% row(s)); deleting restores their higher default', gone;
  end if;
  raise notice 'A-17 OK: a restricted member cannot delete their own social override';
end $$;

-- ── Positive control: a parent still can ─────────────────────────────────────
-- A guard that refuses everyone proves nothing about the boundary.
do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a02', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;

  perform set_config('role','postgres', true);
  if gone <> 1 then
    raise exception 'A-17 FAIL: an admin could not remove an override (% row(s)) — the policy is now too tight', gone;
  end if;
  raise notice 'A-17 OK: an admin can still remove an override (positive control)';
end $$;

-- ── The three write verbs agree ──────────────────────────────────────────────
do $$
declare ins text; upd text; del text;
begin
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into ins
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='a';
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into upd
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='w';
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into del
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='d';
  if del is distinct from ins or del is distinct from upd then
    raise exception 'A-17 FAIL: write verbs disagree — insert=% update=% delete=%', ins, upd, del;
  end if;
  raise notice 'A-17 OK: insert, update and delete carry the same condition';
end $$;

-- ── The probe detects the state it forbids ───────────────────────────────────
begin;
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
  values (:'FS',:'UA','read_only','active',:'UP') on conflict (family_id, user_id) do update set social_role = 'read_only';
drop policy if exists social_access_permissions_delete on public.social_access_permissions;
create policy social_access_permissions_delete on public.social_access_permissions
  for delete to authenticated using (public.is_family_member(family_id));
do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a03', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;
  perform set_config('role','postgres', true);
  if gone <> 1 then
    raise exception 'A-17 FAIL: the pre-0296 policy was restored and the member still could NOT delete — this probe proves nothing';
  end if;
  raise notice 'A-17 OK: with 0034''s delete policy restored the member CAN remove their restriction — not decoration';
end $$;
rollback;

do $$
declare expr text;
begin
  select coalesce(pg_get_expr(p.polqual,p.polrelid),'') into expr
    from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname='social_access_permissions' and p.polcmd='d';
  if expr not like '%is_family_admin%' then
    raise exception 'A-17 FAIL: the planted policy survived the rollback';
  end if;
  raise notice 'A-17 OK: the planted policy was rolled back';
end $$;
