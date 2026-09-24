-- Onboarding resumes only your own family. (SEC-018)
--
-- `onboarding_claim_family` lets a double-submitted or interrupted wizard land
-- on the family it already started, by resuming from
-- `onboarding_progress.family_id`. That row is the user's own —
-- `onboarding_progress_insert`/`_update` check `user_id = auth.uid()` — and
-- nothing constrained `family_id`. The onboarding action then upserts the
-- caller into the resumed family as a PARENT, with the service role.
--
-- Reproduced with real sessions: a fresh account with no family
--
--   upserts its own onboarding_progress with family_id = <victim family>   -> allowed
--   runs onboarding: onboarding_claim_family -> {family_id: <victim>, created: false}
--   parent membership upsert                                                -> ok
--   in its own session: role in the victim family -> parent
--   the victim family's password vault -> [{"label":"Home wifi","secret":"the-real-wifi-password"}]
--
-- The only prerequisite is the family's id, which every family sharing a
-- marketplace circle with it can read from marketplace_circle_members, and
-- which every past member already knows.
--
-- `prepareCalendarFamily` has always refused this ("Family owner changed").
-- The main onboarding action did not; it now does, which holds from the moment
-- that code deploys. This migration closes the database half twice over:
--
--   1. The function resumes only a family the caller CREATED and that has no
--      other login member. The second condition also stops a creator who was
--      removed from their own family re-onboarding their way back in as a
--      parent: a legitimate resume only ever reaches this branch with no
--      active membership of their own and no other login member yet, because
--      the owner's membership is the first thing the wizard writes.
--   2. Clients can no longer choose the row's family_id. Every writer of that
--      column is the service role (lib/server/onboarding-progress.ts,
--      lib/server/ensure-family.ts, this function); the one client update in
--      the product — prepareCalendarFamily resetting source and status — keeps
--      its columns. INSERT from clients is revoked outright; nothing uses it.

create or replace function public.onboarding_claim_family(p_user_id uuid, p_name text, p_timezone text)
returns table(family_id uuid, created boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
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

  -- Resume only this user's own, still-unclaimed wizard family (0331).
  select op.family_id into v_family_id
    from public.onboarding_progress op
    join public.families f on f.id = op.family_id
   where op.user_id = p_user_id
     and op.status <> 'completed'
     and op.family_id is not null
     and f.created_by = p_user_id
     and not exists (
           select 1 from public.family_members fm
            where fm.family_id = op.family_id
              and fm.is_active
              and fm.user_id is not null
              and fm.user_id <> p_user_id)
   limit 1;
  if v_family_id is not null then
    return query select v_family_id, false;
    return;
  end if;

  insert into public.families (name, timezone, created_by)
  values (p_name, p_timezone, p_user_id)
  returning id into v_family_id;

  -- A progress row that pointed anywhere else failed the check above, so the
  -- new family replaces it rather than being coalesced behind it.
  insert into public.onboarding_progress (user_id, family_id, source, status, steps_completed)
  values (p_user_id, v_family_id, 'wizard', 'in_progress', '{}')
  on conflict (user_id) do update
    set family_id = excluded.family_id,
        source = 'wizard',
        status = 'in_progress',
        steps_completed = '{}';

  return query select v_family_id, true;
end;
$$;

comment on function public.onboarding_claim_family(uuid, text, text) is
  'Claims the caller''s first family under a per-user lock. Resumes only a family the caller created that has no other login member (0331, SEC-018).';

-- Clients cannot choose which family their onboarding row names.
do $$
declare
  v_cols text;
begin
  revoke insert on public.onboarding_progress from anon, authenticated;
  revoke update on public.onboarding_progress from anon, authenticated;
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.onboarding_progress'::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('id', 'user_id', 'family_id', 'created_at');
  execute format('grant update (%s) on public.onboarding_progress to authenticated', v_cols);
end $$;

do $$
begin
  if has_column_privilege('authenticated', 'public.onboarding_progress', 'family_id', 'UPDATE')
     or has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') then
    raise exception '0331: a client can still choose its onboarding family';
  end if;
  if not has_column_privilege('authenticated', 'public.onboarding_progress', 'status', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.onboarding_progress', 'source', 'UPDATE') then
    raise exception '0331: the calendar setup path lost the columns it updates';
  end if;
end $$;
