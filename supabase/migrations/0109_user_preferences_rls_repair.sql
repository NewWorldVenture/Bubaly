-- FamilyOS :: 0109 user_preferences RLS repair
-- ----------------------------------------------------------------------------
-- Production-drift safeguard (same class as 0105/0106/0107). The canonical
-- policy from 0004 (`prefs_all` FOR ALL, own-row) drifted in production, leaving
-- no valid INSERT policy — so upserting a member's own preferences (e.g. saving
-- Capture shortcuts) failed with:
--   "new row violates row-level security policy for table user_preferences".
--
-- Re-assert own-row policies for SELECT/INSERT/UPDATE/DELETE keyed on
-- `user_id = auth.uid()`. Granular (not just FOR ALL) so the INSERT path is
-- always covered. Idempotent; no data change.

alter table public.user_preferences enable row level security;

-- Replace the (possibly drifted) blanket policy.
drop policy if exists prefs_all on public.user_preferences;

drop policy if exists user_preferences_select on public.user_preferences;
create policy user_preferences_select on public.user_preferences
  for select using (user_id = auth.uid());

drop policy if exists user_preferences_insert on public.user_preferences;
create policy user_preferences_insert on public.user_preferences
  for insert with check (user_id = auth.uid());

drop policy if exists user_preferences_update on public.user_preferences;
create policy user_preferences_update on public.user_preferences
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_preferences_delete on public.user_preferences;
create policy user_preferences_delete on public.user_preferences
  for delete using (user_id = auth.uid());
