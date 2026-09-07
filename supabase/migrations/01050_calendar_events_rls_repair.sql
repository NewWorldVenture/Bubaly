-- Bubaly :: 0105 calendar_events RLS repair
-- ----------------------------------------------------------------------------
-- Production drift fix: some environments ended up with RLS enabled on
-- public.calendar_events but WITHOUT the standard family-scoped SELECT policy
-- (or with a stale one), so authenticated reads returned zero rows even for
-- valid family members — the Calendar page rendered empty despite data being
-- present. This re-asserts the exact policies 0004_rls.sql intends, idempotently.
--
-- Safe to run anywhere: DROP ... IF EXISTS + CREATE recreates the canonical
-- is_family_member(family_id) policy for every CRUD verb.

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select using (public.is_family_member(family_id));

drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events
  for insert with check (public.is_family_member(family_id));

drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events
  for update using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events
  for delete using (public.is_family_member(family_id));
