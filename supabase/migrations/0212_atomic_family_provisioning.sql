-- FamilyOS :: 0212 atomic first-family provisioning
--
-- Protected layouts can be requested concurrently (multiple tabs, refreshes,
-- or parallel server components). Serialize the first-family decision per
-- account so one user cannot receive duplicate household spaces.

create or replace function public.ensure_family_for_user(
  p_user_id uuid,
  p_name text,
  p_timezone text default 'UTC',
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_family_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not authorized';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select fm.family_id into v_family_id
    from public.family_members fm
   where fm.user_id = p_user_id
     and fm.is_active = true
   order by fm.created_at
   limit 1;
  if v_family_id is not null then
    return v_family_id;
  end if;

  insert into public.families (name, timezone, created_by)
  values (p_name, p_timezone, p_user_id)
  returning id into v_family_id;

  insert into public.family_members (family_id, user_id, role, display_name, is_active)
  values (v_family_id, p_user_id, 'parent', coalesce(nullif(trim(p_display_name), ''), nullif(trim(p_name), ''), 'Parent'), true)
  on conflict (family_id, user_id) do update
    set role = excluded.role,
        is_active = true;

  insert into public.subscriptions (family_id, plan, status, current_period_end)
  select v_family_id, 'free', 'trialing', now() + interval '14 days'
   where not exists (
     select 1 from public.subscriptions s where s.family_id = v_family_id
   );

  insert into public.user_preferences (user_id, active_family_id)
  values (p_user_id, v_family_id)
  on conflict (user_id) do update
    set active_family_id = excluded.active_family_id;

  return v_family_id;
end;
$$;

revoke all on function public.ensure_family_for_user(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_family_for_user(uuid, text, text, text) to service_role;
