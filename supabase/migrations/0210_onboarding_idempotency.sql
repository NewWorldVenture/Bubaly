-- FamilyOS :: 0210 onboarding finalization idempotency
--
-- A wizard request can be retried after a browser timeout or a partial write.
-- Nullable keys preserve all historical rows while giving new finalizations a
-- database-enforced identity for each managed row, invite, imported event, and
-- import marker.

alter table public.family_members
  add column if not exists onboarding_key text;

alter table public.invites
  add column if not exists onboarding_key text;

alter table public.calendar_events
  add column if not exists onboarding_key text;

alter table public.onboarding_imports
  add column if not exists onboarding_key text;

create unique index if not exists idx_family_members_onboarding_key
  on public.family_members (family_id, onboarding_key);

create unique index if not exists idx_invites_onboarding_key
  on public.invites (family_id, onboarding_key);

create unique index if not exists idx_calendar_events_onboarding_key
  on public.calendar_events (family_id, onboarding_key);

create unique index if not exists idx_onboarding_imports_onboarding_key
  on public.onboarding_imports (family_id, onboarding_key);

-- Serialize first-family claims for one account. This closes the small window
-- where two simultaneous first submissions could both observe no membership and
-- mint separate families before the trigger membership becomes visible.
create or replace function public.onboarding_claim_family(
  p_user_id uuid,
  p_name text,
  p_timezone text
)
returns table (family_id uuid, created boolean)
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
   where fm.user_id = p_user_id and fm.is_active = true
   order by fm.created_at
   limit 1;
  if v_family_id is not null then
    return query select v_family_id, false;
    return;
  end if;

  select op.family_id into v_family_id
    from public.onboarding_progress op
   where op.user_id = p_user_id
     and op.status <> 'completed'
     and op.family_id is not null
   limit 1;
  if v_family_id is not null then
    return query select v_family_id, false;
    return;
  end if;

  insert into public.families (name, timezone, created_by)
  values (p_name, p_timezone, p_user_id)
  returning id into v_family_id;

  insert into public.onboarding_progress (user_id, family_id, source, status, steps_completed)
  values (p_user_id, v_family_id, 'wizard', 'in_progress', '{}')
  on conflict (user_id) do update
    set family_id = coalesce(public.onboarding_progress.family_id, excluded.family_id),
        source = 'wizard',
        status = 'in_progress',
        steps_completed = '{}';

  return query select v_family_id, true;
end;
$$;

revoke all on function public.onboarding_claim_family(uuid, text, text) from public, anon, authenticated;
grant execute on function public.onboarding_claim_family(uuid, text, text) to service_role;
