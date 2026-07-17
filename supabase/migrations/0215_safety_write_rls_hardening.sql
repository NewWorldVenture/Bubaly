-- 0215 — Defense-in-depth: manager-only WRITES on safety-critical shared tables.
--
-- App-level authorization already blocks non-managers from these mutations
-- (PLA-0470 guardian actions, PLA-0520 locator actions), but the tables shipped
-- with `is_family_member(family_id)` FOR ALL, so a future missed gate or a direct
-- PostgREST call by a signed-in child could still tamper with the call/message
-- screening rules or the geofences that drive location safety alerts.
--
-- This migration keeps SELECT open to every family member (a child's device must
-- read the family geofences to detect arrivals, and everyone can view screening
-- rules) but restricts INSERT/UPDATE/DELETE to family managers (parent/adult) via
-- can_manage_family(). Service-role writes (AI learning) bypass RLS and are
-- unaffected. Additive + idempotent; self-location (member_locations) and child
-- chore submissions are intentionally NOT changed.

-- ── family_places (geofences → arrival/departure alerts) ─────────────────────
alter table public.family_places enable row level security;
drop policy if exists "Members can manage family_places" on public.family_places;
drop policy if exists family_places_select on public.family_places;
drop policy if exists family_places_insert on public.family_places;
drop policy if exists family_places_update on public.family_places;
drop policy if exists family_places_delete on public.family_places;
create policy family_places_select on public.family_places
  for select to authenticated using (public.is_family_member(family_id));
create policy family_places_insert on public.family_places
  for insert to authenticated with check (public.can_manage_family(family_id));
create policy family_places_update on public.family_places
  for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
create policy family_places_delete on public.family_places
  for delete to authenticated using (public.can_manage_family(family_id));

-- ── guardian_routing_rules (call/message screening) ──────────────────────────
-- SELECT remains via the existing "Family member can view guardian_routing_rules".
alter table public.guardian_routing_rules enable row level security;
drop policy if exists "Family member can manage guardian_routing_rules" on public.guardian_routing_rules;
drop policy if exists guardian_routing_rules_insert on public.guardian_routing_rules;
drop policy if exists guardian_routing_rules_update on public.guardian_routing_rules;
drop policy if exists guardian_routing_rules_delete on public.guardian_routing_rules;
create policy guardian_routing_rules_insert on public.guardian_routing_rules
  for insert to authenticated with check (public.can_manage_family(family_id));
create policy guardian_routing_rules_update on public.guardian_routing_rules
  for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
create policy guardian_routing_rules_delete on public.guardian_routing_rules
  for delete to authenticated using (public.can_manage_family(family_id));
