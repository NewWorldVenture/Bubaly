-- Bubaly :: 0460 A child cannot rewrite the family's subscriptions
-- ----------------------------------------------------------------------------
-- `subscriptions_tracked` (0076) holds the household's recurring charges —
-- streaming, insurance, the gym — with their cost and next charge date. Its one
-- policy, "Members manage subscriptions_tracked", is `FOR ALL` on
-- `is_family_member(family_id)`: every command, for every member. 0267 closed
-- exactly this shape on the five money tables beside it and named its reason —
-- children have real sessions, and every finance write surface runs through the
-- browser client with no check of its own — but this table was not in its list.
--
-- Measured (finalaudit.md, page audit B11): a child signed in through
-- `/kid-login` with a PIN opened Subscriptions and pressed "Add subscription";
-- the row was written. The same session could equally cancel, re-price or
-- delete the parent's rows. API-SWEEP-06 recorded the table as member-writable
-- from the other direction, while tracing a child's reads.
--
-- WRITES ONLY, as 0267. `select` keeps `is_family_member`: who may READ the
-- family's finances is API-SWEEP-06's other half and the owner's decision, and
-- the home page, briefing, autopilot and agents read this table too.
--
-- The only writer in the app is components/modules/subscriptions-module.tsx
-- (browser client), which already reports a refused write in words. The server
-- readers (autopilot scan, insights, savings, moving, price history, candidate
-- review) only read.
--
-- Idempotent: the wide policy is dropped by name, the four are dropped and
-- recreated by name.

drop policy if exists "Members manage subscriptions_tracked" on public.subscriptions_tracked;

drop policy if exists subscriptions_tracked_select on public.subscriptions_tracked;
create policy subscriptions_tracked_select on public.subscriptions_tracked
  for select using (public.is_family_member(family_id));

drop policy if exists subscriptions_tracked_insert on public.subscriptions_tracked;
create policy subscriptions_tracked_insert on public.subscriptions_tracked
  for insert with check (public.can_manage_family(family_id));

drop policy if exists subscriptions_tracked_update on public.subscriptions_tracked;
create policy subscriptions_tracked_update on public.subscriptions_tracked
  for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));

drop policy if exists subscriptions_tracked_delete on public.subscriptions_tracked;
create policy subscriptions_tracked_delete on public.subscriptions_tracked
  for delete using (public.can_manage_family(family_id));
