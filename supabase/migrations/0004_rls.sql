-- FamilyOS :: 0004 row level security
-- Hard guarantee: no row crosses a family boundary. Every household table is gated
-- by is_family_member(family_id). Reference tables are read-only to authenticated users.

-- Enable RLS everywhere.
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- ---------- Generic family-scoped tables (members get full CRUD within their family) ----------
do $$
declare t text;
declare fam_tables text[] := array[
  'calendar_events','school_events','sports_events','appointments',
  'chores','chore_assignments','rewards',
  'meals','meal_plans','grocery_lists','grocery_items',
  'medications','medication_schedules',
  'home_assets','maintenance_tasks',
  'documents','notes','goals','reminders',
  'ai_conversations','ai_messages'
];
begin
  foreach t in array fam_tables loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- ---------- profiles ----------
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and them.user_id = public.profiles.id
    )
  );
drop policy if exists profiles_upsert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (id = auth.uid());
create policy profiles_update_self on public.profiles for update using (id = auth.uid());

-- ---------- families ----------
drop policy if exists families_select on public.families;
create policy families_select on public.families for select
  using (public.is_family_member(id));
drop policy if exists families_insert on public.families;
create policy families_insert on public.families for insert
  with check (created_by = auth.uid());
drop policy if exists families_update on public.families;
create policy families_update on public.families for update
  using (public.can_manage_family(id));
drop policy if exists families_delete on public.families;
create policy families_delete on public.families for delete
  using (public.is_family_admin(id));

-- ---------- family_members ----------
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));
drop policy if exists fm_manage on public.family_members;
create policy fm_insert on public.family_members for insert
  with check (public.can_manage_family(family_id));
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id) or user_id = auth.uid());
create policy fm_delete on public.family_members for delete
  using (public.can_manage_family(family_id));

-- ---------- reference tables (read-only to all authenticated) ----------
drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles for select using (auth.role() = 'authenticated');
drop policy if exists perms_read on public.permissions;
create policy perms_read on public.permissions for select using (auth.role() = 'authenticated');

-- ---------- invites ----------
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (
    public.is_family_member(family_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
drop policy if exists invites_manage on public.invites;
create policy invites_insert on public.invites for insert
  with check (public.can_manage_family(family_id));
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
create policy invites_delete on public.invites for delete
  using (public.can_manage_family(family_id));

-- ---------- notifications (recipient-scoped or family broadcast) ----------
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  with check (public.is_family_member(family_id));
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete
  using (user_id = auth.uid() or public.can_manage_family(family_id));

-- ---------- audit_logs (members append; managers read) ----------
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select
  using (public.can_manage_family(family_id));
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert
  with check (family_id is null or public.is_family_member(family_id));

-- ---------- billing + subscriptions (members read, admin manages) ----------
drop policy if exists billing_select on public.billing_customers;
create policy billing_select on public.billing_customers for select
  using (public.is_family_member(family_id));
drop policy if exists billing_manage on public.billing_customers;
create policy billing_manage on public.billing_customers for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select
  using (public.is_family_member(family_id));
drop policy if exists subs_manage on public.subscriptions;
create policy subs_manage on public.subscriptions for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

-- ---------- user_preferences (own only) ----------
drop policy if exists prefs_all on public.user_preferences;
create policy prefs_all on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
