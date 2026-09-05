-- Bubaly :: 0134 Model staleness flag (event-driven twin refresh)
-- ----------------------------------------------------------------------------
-- Makes the Household Twin graph + Prep Plans refresh EVENT-DRIVEN, not just on a
-- schedule. When any cross-domain source row changes (members, pets, vehicles,
-- schools, teams, routines, places, accounts, trips, documents), a trigger stamps
-- the family's row in `family_model_dirty`. The model-refresh cron then prioritizes
-- dirty families and clears the flag after a successful refresh, so a change is
-- reflected on the next tick instead of waiting a full cycle.
--
-- Additive + idempotent. Family-scoped RLS (read-only to members; writes happen
-- via SECURITY DEFINER trigger, never directly from clients).

create table if not exists public.family_model_dirty (
  family_id   uuid primary key references public.families(id) on delete cascade,
  dirty       boolean not null default true,
  reason      text,                    -- last table that dirtied it
  marked_at   timestamptz not null default now(),
  refreshed_at timestamptz
);

alter table public.family_model_dirty enable row level security;
drop policy if exists family_model_dirty_select on public.family_model_dirty;
create policy family_model_dirty_select on public.family_model_dirty
  for select using (public.is_family_member(family_id));
-- No client insert/update/delete policies: only the trigger (definer) + service role write.

-- Trigger function: mark the changed row's family dirty. SECURITY DEFINER so it can
-- write regardless of the caller's RLS. Resolves family_id from the affected row.
create or replace function public.mark_model_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid;
begin
  v_family := coalesce((case when tg_op = 'DELETE' then old.family_id else new.family_id end), null);
  if v_family is not null then
    insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
    values (v_family, true, tg_table_name, now())
    on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();
  end if;
  return null; -- AFTER trigger, result ignored
end $$;

-- Attach the trigger to every cross-domain source table the twin projector reads.
do $$
declare
  t text;
  tables text[] := array[
    'family_members','pets','vehicles','school_classes','teams',
    'family_routines','family_places','financial_accounts','vacations','documents'
  ];
begin
  foreach t in array tables loop
    -- Skip gracefully if a table doesn't exist in this environment.
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_mark_model_dirty on public.%I', t);
      execute format(
        'create trigger trg_mark_model_dirty after insert or update or delete on public.%I '
        'for each row execute function public.mark_model_dirty()', t);
    end if;
  end loop;
end $$;
