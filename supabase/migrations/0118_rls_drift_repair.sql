-- 0118_rls_drift_repair.sql
-- Consolidated repair for the systemic production RLS drift found on 2026-06-30:
-- tables had RLS ENABLED but their family-scoped policies were missing in prod,
-- so every authenticated read silently returned 0 rows ("seeded but page is
-- empty"). Piecemeal repairs shipped as 0105 (calendar_events), 0106 (todos),
-- 0107 (meals domain), 0109 (finance domain); this migration closes the TODO by
-- auditing EVERY table and healing whatever is still broken — including tables
-- added since — in one idempotent pass.
--
-- Safety model (cannot weaken anything):
--   A. RLS is (re-)enabled on every public base table — same as 0004.
--   B. The special-case tables from 0004 (profiles, families, family_members,
--      invites, notifications, audit_logs, billing_customers, subscriptions,
--      user_preferences) get their ORIGINAL, stricter policy shapes re-asserted
--      verbatim (drop-if-exists + create — a faithful re-run of 0004).
--   C. Every OTHER table with a family_id column is healed ONLY IF it currently
--      has NO SELECT policy at all (the drift symptom). Tables that already
--      carry any select policy — including intentionally stricter custom ones —
--      are left completely untouched.
-- Re-running is a no-op wherever policies exist. Postgres-only; no data change.

-- A) Enable RLS everywhere (idempotent) ---------------------------------------
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

-- B) Re-assert 0004's special-case policies verbatim ---------------------------
-- profiles: self + family visibility; self-only writes.
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
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid());

-- families
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

-- family_members
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert
  with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id) or user_id = auth.uid());
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete
  using (public.can_manage_family(family_id));

-- invites
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (
    public.is_family_member(family_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert
  with check (public.can_manage_family(family_id));
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete
  using (public.can_manage_family(family_id));

-- notifications (recipient-scoped or family broadcast)
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

-- audit_logs (members append; managers read)
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select
  using (public.can_manage_family(family_id));
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert
  with check (family_id is null or public.is_family_member(family_id));

-- billing + subscriptions (members read, admin manages)
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

-- user_preferences (own only)
drop policy if exists prefs_all on public.user_preferences;
create policy prefs_all on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- C) Heal every other family_id table that has NO select policy ----------------
-- Only tables exhibiting the drift symptom (RLS on, zero select policies) get
-- the generic family CRUD set; anything with an existing select policy is
-- skipped so custom/stricter shapes are never overwritten.
do $$
declare t text;
declare healed text[] := '{}';
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'family_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_name not in (
        'families','family_members','invites','notifications','audit_logs',
        'billing_customers','subscriptions'
      )
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.table_name
          and p.cmd in ('SELECT','ALL')
      )
  loop
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    healed := array_append(healed, t);
  end loop;
  raise notice 'RLS drift repair healed % table(s): %', coalesce(array_length(healed,1),0), healed;
end $$;

-- D) Post-repair audit (informational): any family_id table still lacking a
-- select policy after this migration indicates a NEW kind of drift — investigate.
do $$
declare remaining text[];
begin
  select array_agg(c.table_name) into remaining
  from information_schema.columns c
  join information_schema.tables tb
    on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'family_id'
    and tb.table_type = 'BASE TABLE'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = c.table_name
        and p.cmd in ('SELECT','ALL')
    );
  if remaining is not null then
    raise warning 'Tables STILL missing a select policy after repair: %', remaining;
  else
    raise notice 'RLS audit clean: every family_id table has a select policy.';
  end if;
end $$;
